import type { TreeSpecies } from '../generator/types'
import {
  bakeProceduralTreeTextureData,
  createProceduralTreeTextures,
  treeMaterialKey,
  treeMaterialSeed,
  type ProceduralTreeTextureData,
  type ProceduralTreeTextures,
  type TreeTextureResolution,
} from './proceduralTreeTextures'
import type {
  ProceduralTreeTextureBakeReply,
  ProceduralTreeTextureBakeRequest,
} from './proceduralTreeTexture.worker'

export interface ProceduralTreeTextureBakeOptions {
  signal?: AbortSignal
  resolution?: TreeTextureResolution
}

interface CacheEntry {
  key: string
  promise: Promise<ProceduralTreeTextures>
  cancel(): void
  pending: boolean
  consumers: number
  lastUsed: number
  textures?: ProceduralTreeTextures
}

/**
 * Two complete texture sets cover the current tree and one undo/redo neighbour
 * without retaining an unbounded payload for every seed visited in the editor.
 * Callers receive reference-counted leases; staged and presented trees can use
 * the same GPU resources while a rebuild is being swapped into view.
 */
const CACHE_LIMIT = 2
const textureCache = new Map<string, CacheEntry>()
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
  const textures = await acquireTextures(
    species,
    seed,
    options.signal,
    options.resolution,
  )
  if (options.signal?.aborted) {
    textures.dispose()
    throw abortError()
  }
  return textures
}

/** Starts or joins a material bake without taking long-term ownership. */
export async function preloadProceduralTreeTextures(
  species: TreeSpecies,
  seed: number,
  options: ProceduralTreeTextureBakeOptions = {},
): Promise<void> {
  const textures = await bakeProceduralTreeTexturesAsync(species, seed, options)
  textures.dispose()
}

/** Test/dev hook; active leases remain valid until their owners release them. */
export function clearProceduralTreeTextureCache(): void {
  for (const entry of textureCache.values()) {
    if (entry.pending) entry.cancel()
    else if (entry.consumers === 0) entry.textures?.dispose()
  }
  textureCache.clear()
}

function acquireTextures(
  species: TreeSpecies,
  _seed: number,
  signal?: AbortSignal,
  resolution: TreeTextureResolution = 'hero',
): Promise<ProceduralTreeTextures> {
  if (signal?.aborted) return Promise.reject(abortError())
  const key = `${treeMaterialKey(species)}:${resolution}`
  const seed = treeMaterialSeed(species)
  let entry = textureCache.get(key)
  if (!entry) {
    entry = createEntry(key, species, seed, resolution)
    textureCache.set(key, entry)
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
      callback()
    }
    const release = () => releaseEntry(key, entry!)
    const onAbort = () => finish(() => {
      release()
      reject(abortError())
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    entry!.promise.then(
      (textures) => finish(() => resolve(createTextureLease(textures, release))),
      (error: unknown) => finish(() => {
        release()
        reject(error)
      }),
    )
  })
}

function createEntry(
  key: string,
  species: TreeSpecies,
  seed: number,
  resolution: TreeTextureResolution,
): CacheEntry {
  const job = startBake(species, seed, resolution)
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
      const textures = createProceduralTreeTextures(data, true)
      entry.pending = false
      entry.textures = textures
      pruneCache()
      return textures
    },
  ).catch(
    (error: unknown) => {
      entry.pending = false
      if (textureCache.get(key) === entry) textureCache.delete(key)
      throw error
    },
  )
  return entry
}

function startBake(
  species: TreeSpecies,
  seed: number,
  resolution: TreeTextureResolution,
): { promise: Promise<ProceduralTreeTextureData>; cancel(): void } {
  if (typeof Worker === 'undefined') return bakeWithoutWorker(species, seed, resolution)

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
    const request: ProceduralTreeTextureBakeRequest = { species, seed, resolution }
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
  resolution: TreeTextureResolution,
): { promise: Promise<ProceduralTreeTextureData>; cancel(): void } {
  let timer = 0
  let rejectJob: (reason: unknown) => void = () => undefined
  const promise = new Promise<ProceduralTreeTextureData>((resolve, reject) => {
    rejectJob = reject
    // Yield once for SSR/tests and old browsers. The production viewport has
    // Worker support; this fallback preserves correctness, not responsiveness.
    timer = globalThis.setTimeout(
      () => resolve(bakeProceduralTreeTextureData(species, seed, resolution)),
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
  if (textureCache.size <= CACHE_LIMIT) return
  const evictable = [...textureCache.values()]
    .filter((entry) => !entry.pending && entry.consumers === 0)
    .sort((a, b) => a.lastUsed - b.lastUsed)
  while (textureCache.size > CACHE_LIMIT && evictable.length > 0) {
    const entry = evictable.shift()!
    if (textureCache.get(entry.key) !== entry) continue
    textureCache.delete(entry.key)
    entry.textures?.dispose()
  }
}

function releaseEntry(key: string, entry: CacheEntry): void {
  entry.consumers -= 1
  if (entry.pending && entry.consumers === 0) {
    entry.cancel()
    if (textureCache.get(key) === entry) textureCache.delete(key)
    return
  }
  if (entry.consumers === 0 && textureCache.get(key) !== entry) {
    entry.textures?.dispose()
    return
  }
  pruneCache()
}

function createTextureLease(
  textures: ProceduralTreeTextures,
  release: () => void,
): ProceduralTreeTextures {
  let released = false
  return {
    barkMap: textures.barkMap,
    barkNormalMap: textures.barkNormalMap,
    barkNormalScale: textures.barkNormalScale,
    barkProjection: textures.barkProjection,
    barkRoughnessMap: textures.barkRoughnessMap,
    leafCards: textures.leafCards,
    leafAtlas: textures.leafAtlas,
    dispose() {
      if (released) return
      released = true
      release()
    },
  }
}

function abortError(): DOMException {
  return new DOMException('Tree texture baking was cancelled', 'AbortError')
}
