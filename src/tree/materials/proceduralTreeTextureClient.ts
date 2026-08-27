import type { TreeSpecies } from '../generator/types'
import {
  createProceduralTreeTextures,
  treeMaterialKey,
  treeMaterialSeed,
  type ProceduralTreeTextures,
  type TreeTextureResolution,
} from './proceduralTreeTextures'
import { bakeTreeTexturesOnPool } from './textureBakePool'

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
 * Enough complete sets for every material a forest preset mixes, plus a spare
 * for the tree the editor was on before it.
 *
 * A cache that only held two was the single most expensive thing about
 * planting a forest: the presets mix up to four bark/foliage profiles, each
 * material is preloaded and released while its prototype compiles, and the
 * third preload evicted the first — so the set was baked again from scratch
 * the moment its trees mounted. Each retained set is roughly forty megabytes
 * at forest resolution, which is the honest cost of not baking it twice.
 */
const CACHE_LIMIT = 6
const textureCache = new Map<string, CacheEntry>()
let useClock = 0

/**
 * Asynchronously bakes all tree maps off the main thread.
 *
 * The returned texture set is exclusively owned by the caller, which must
 * invoke `dispose()` on replacement/unmount. Aborting rejects only this
 * consumer; when the last consumer leaves a pending entry the bake is
 * cancelled too, so rapid seed edits do not queue work nobody is waiting for.
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
  const job = bakeTreeTexturesOnPool(species, seed, resolution)
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
    barkMossiness: textures.barkMossiness,
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
