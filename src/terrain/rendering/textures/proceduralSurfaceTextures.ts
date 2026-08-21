import {
  type ColorSpace,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three/webgpu'
import { PROCEDURAL_SURFACES, type ProceduralSurfaceId } from './procedural/materials'
import type { ProceduralBakeReply, ProceduralBakeRequest } from './proceduralBake.worker'

/**
 * Shared procedural rock materials.
 *
 * Each surface is baked exactly once for the lifetime of the page and handed
 * out as the same `Texture` instances to every caller, so binding it on a
 * hundred meshes costs one descriptor, not a hundred bakes. The maps are
 * ordinary mip-mapped, anisotropically filtered textures: sampling cost does
 * not change with camera distance, and nothing in this module runs per frame.
 *
 * The bake itself happens in a worker. Callers get their textures
 * synchronously, filled with the surface's average colour, and the real pixels
 * are swapped into the same objects when they arrive — first a fast
 * low-resolution pass so the material stops being flat within a moment, then
 * the full-resolution one. Because the `Texture` identity never changes, no
 * material has to be rebuilt and no pipeline is recompiled.
 */

export interface ProceduralSurfaceTextures {
  id: ProceduralSurfaceId
  albedo: DataTexture
  normal: DataTexture
  arm: DataTexture
  displacement: DataTexture
  /** Metres spanned by one tile of the bake. */
  physicalWidth: number
  /** Peak-to-trough relief in metres. */
  reliefDepth: number
  /** Resolves when the full-resolution bake has been uploaded. */
  ready: Promise<void>
}

/** Resolution of the first, near-immediate pass. */
const PREVIEW_SIZE = 256
/** Resolution of the final bake. */
const FULL_SIZE = 1024

/** Average colour of each surface, used until the bake lands. */
const PLACEHOLDER: Record<ProceduralSurfaceId, readonly [number, number, number]> = {
  'rock-ground': [116, 109, 96],
  'cliff-side': [150, 116, 74],
  'alpine-cliff-rock': [78, 80, 76],
  'ember-fault-rock': [48, 48, 48],
}

const cache = new Map<ProceduralSurfaceId, ProceduralSurfaceTextures>()

function createPlaceholder(
  rgb: readonly [number, number, number],
  name: string,
  colorSpace: ColorSpace,
): DataTexture {
  const texture = new DataTexture(
    new Uint8Array([rgb[0], rgb[1], rgb[2], 255]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType,
  )
  texture.name = name
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 16
  texture.colorSpace = colorSpace
  texture.needsUpdate = true
  return texture
}

function upload(texture: DataTexture, data: Uint8Array, size: number): void {
  texture.image = { data, width: size, height: size }
  texture.needsUpdate = true
}

let worker: Worker | null = null
let workerFailed = false

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker
  if (typeof Worker === 'undefined') {
    workerFailed = true
    return null
  }
  try {
    worker = new Worker(new URL('./proceduralBake.worker.ts', import.meta.url), {
      type: 'module',
    })
  } catch {
    // Older bundlers and non-browser hosts: fall back to the placeholder.
    workerFailed = true
    worker = null
  }
  return worker
}

let nextToken = 1
const pending = new Map<number, (reply: ProceduralBakeReply) => void>()

function bakeInWorker(
  id: ProceduralSurfaceId,
  size: number,
  seed: number,
): Promise<ProceduralBakeReply> | null {
  const instance = getWorker()
  if (!instance) return null
  if (pending.size === 0) {
    instance.onmessage = (event: MessageEvent<ProceduralBakeReply>) => {
      const resolve = pending.get(event.data.token)
      if (!resolve) return
      pending.delete(event.data.token)
      resolve(event.data)
    }
  }
  const token = nextToken
  nextToken += 1
  const request: ProceduralBakeRequest = { id, size, seed, token }
  return new Promise<ProceduralBakeReply>((resolve) => {
    pending.set(token, resolve)
    instance.postMessage(request)
  })
}

function applyReply(target: ProceduralSurfaceTextures, reply: ProceduralBakeReply): void {
  upload(target.albedo, new Uint8Array(reply.albedo), reply.size)
  upload(target.normal, new Uint8Array(reply.normal), reply.size)
  upload(target.arm, new Uint8Array(reply.arm), reply.size)
  upload(target.displacement, new Uint8Array(reply.displacement), reply.size)
  target.physicalWidth = reply.physicalWidth
  target.reliefDepth = reply.reliefDepth
}

/**
 * Returns the shared texture set for one procedural surface, baking it on
 * first use. Subsequent calls return the same objects immediately.
 */
export function getProceduralSurfaceTextures(
  id: ProceduralSurfaceId,
  seed = 1,
): ProceduralSurfaceTextures {
  const existing = cache.get(id)
  if (existing) return existing

  const recipe = PROCEDURAL_SURFACES[id]
  const placeholder = PLACEHOLDER[id]
  const entry: ProceduralSurfaceTextures = {
    id,
    albedo: createPlaceholder(placeholder, `${id} procedural albedo`, SRGBColorSpace),
    normal: createPlaceholder([128, 128, 255], `${id} procedural normal`, NoColorSpace),
    arm: createPlaceholder([255, 230, 0], `${id} procedural ARM`, NoColorSpace),
    displacement: createPlaceholder([128, 128, 128], `${id} procedural height`, NoColorSpace),
    physicalWidth: recipe.physicalWidth,
    reliefDepth: recipe.reliefDepth,
    ready: Promise.resolve(),
  }
  cache.set(id, entry)

  entry.ready = (async () => {
    const preview = bakeInWorker(id, PREVIEW_SIZE, seed)
    if (!preview) return
    applyReply(entry, await preview)
    const full = bakeInWorker(id, FULL_SIZE, seed)
    if (!full) return
    applyReply(entry, await full)
  })()

  return entry
}

/** Test and tooling hook; drops the cache so a fresh bake can be observed. */
export function resetProceduralSurfaceTextures(): void {
  for (const entry of cache.values()) {
    entry.albedo.dispose()
    entry.normal.dispose()
    entry.arm.dispose()
    entry.displacement.dispose()
  }
  cache.clear()
  worker?.terminate()
  worker = null
  workerFailed = false
  pending.clear()
}

export type { ProceduralSurfaceId }
