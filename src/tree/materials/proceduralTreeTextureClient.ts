import type { TreeSpecies } from '../generator/types'
import {
  bakeProceduralTreeTextureData,
  createProceduralTreeTextures,
  type ProceduralTreeTextureData,
  type ProceduralTreeTextures,
} from './proceduralTreeTextures'
import type {
  ProceduralTreeTextureBakeReply,
  ProceduralTreeTextureBakeRequest,
} from './proceduralTreeTexture.worker'

export interface ProceduralTreeTextureBakeOptions {
  signal?: AbortSignal
}

interface CacheEntry {
  key: string
  promise: Promise<ProceduralTreeTextureData>
  cancel(): void
  pending: boolean
  consumers: number
  lastUsed: number
}

/**
 * Two raw bakes cover the current tree and one undo/redo neighbour without
 * retaining an unbounded 36 MiB payload for every seed visited in the editor.
 * GPU textures are never shared: every caller owns and disposes its wrappers.
 */
const CACHE_LIMIT = 2
const rawCache = new Map<string, CacheEntry>()
let useClock = 0

/**
 * Asynchronously bakes all tree maps off the main thread.
 *
 * The returned texture set is exclusively owned by the caller, which must
 * invoke `dispose()` on replacement/unmount. Aborting rejects only this
 * consumer; when the last consumer leaves a pending entry its worker is also
 * terminated, so rapid seed edits do not leave old 14-second bakes running.
 */
export async function bakeProceduralTreeTexturesAsync(
  species: TreeSpecies,
  seed: number,
  options: ProceduralTreeTextureBakeOptions = {},
): Promise<ProceduralTreeTextures> {
  const data = await acquireTextureData(species, seed, options.signal)
  if (options.signal?.aborted) throw abortError()
  return createProceduralTreeTextures(data)
}

/** Test/dev hook; ready entries are bytes only and own no GPU resources. */
export function clearProceduralTreeTextureCache(): void {
  for (const entry of rawCache.values()) {
    if (entry.pending) entry.cancel()
  }
  rawCache.clear()
}

function acquireTextureData(
  species: TreeSpecies,
  seed: number,
  signal?: AbortSignal,
): Promise<ProceduralTreeTextureData> {
  if (signal?.aborted) return Promise.reject(abortError())
  const key = `${species}:${seed >>> 0}`
  let entry = rawCache.get(key)
  if (!entry) {
    entry = createEntry(key, species, seed)
    rawCache.set(key, entry)
  }
  entry.consumers += 1
  entry.lastUsed = ++useClock
  pruneCache()

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      entry!.consumers -= 1
      if (entry!.pending && entry!.consumers === 0) {
        entry!.cancel()
        if (rawCache.get(key) === entry) rawCache.delete(key)
      }
      callback()
    }
    const onAbort = () => finish(() => reject(abortError()))
    signal?.addEventListener('abort', onAbort, { once: true })
    entry!.promise.then(
      (data) => finish(() => resolve(data)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

function createEntry(
  key: string,
  species: TreeSpecies,
  seed: number,
): CacheEntry {
  const job = startBake(species, seed)
  const entry: CacheEntry = {
    key,
    promise: undefined!,
    cancel: job.cancel,
    pending: true,
    consumers: 0,
    lastUsed: ++useClock,
  }
  entry.promise = job.promise.then(
    (data) => {
      entry.pending = false
      pruneCache()
      return data
    },
    (error: unknown) => {
      entry.pending = false
      if (rawCache.get(key) === entry) rawCache.delete(key)
      throw error
    },
  )
  return entry
}

function startBake(
  species: TreeSpecies,
  seed: number,
): { promise: Promise<ProceduralTreeTextureData>; cancel(): void } {
  if (typeof Worker === 'undefined') return bakeWithoutWorker(species, seed)

  const worker = new Worker(
    new URL('./proceduralTreeTexture.worker.ts', import.meta.url),
    { type: 'module', name: 'procedural-tree-texture-baker' },
  )
  let settled = false
  let rejectJob: (reason: unknown) => void = () => undefined
  const finish = (callback: () => void) => {
    if (settled) return
    settled = true
    worker.terminate()
    callback()
  }
  const promise = new Promise<ProceduralTreeTextureData>((resolve, reject) => {
    rejectJob = reject
    worker.onmessage = (event: MessageEvent<ProceduralTreeTextureBakeReply>) => {
      const reply = event.data
      if (reply.kind === 'error') {
        finish(() => reject(new Error(reply.error)))
      } else {
        finish(() => resolve(reply.data))
      }
    }
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || 'Tree texture bake worker failed')))
    }
    worker.onmessageerror = () => {
      finish(() => reject(new Error('Tree texture bake worker returned unreadable data')))
    }
    const request: ProceduralTreeTextureBakeRequest = { species, seed }
    worker.postMessage(request)
  })
  return {
    promise,
    cancel: () => finish(() => rejectJob(abortError())),
  }
}

function bakeWithoutWorker(
  species: TreeSpecies,
  seed: number,
): { promise: Promise<ProceduralTreeTextureData>; cancel(): void } {
  let timer = 0
  let rejectJob: (reason: unknown) => void = () => undefined
  const promise = new Promise<ProceduralTreeTextureData>((resolve, reject) => {
    rejectJob = reject
    // Yield once for SSR/tests and old browsers. The production viewport has
    // Worker support; this fallback preserves correctness, not responsiveness.
    timer = globalThis.setTimeout(
      () => resolve(bakeProceduralTreeTextureData(species, seed)),
      0,
    ) as unknown as number
  })
  return {
    promise,
    cancel() {
      if (!timer) return
      globalThis.clearTimeout(timer)
      timer = 0
      rejectJob(abortError())
    },
  }
}

function pruneCache(): void {
  if (rawCache.size <= CACHE_LIMIT) return
  const evictable = [...rawCache.values()]
    .filter((entry) => !entry.pending && entry.consumers === 0)
    .sort((a, b) => a.lastUsed - b.lastUsed)
  while (rawCache.size > CACHE_LIMIT && evictable.length > 0) {
    const entry = evictable.shift()!
    if (rawCache.get(entry.key) === entry) rawCache.delete(entry.key)
  }
}

function abortError(): DOMException {
  return new DOMException('Tree texture baking was cancelled', 'AbortError')
}
