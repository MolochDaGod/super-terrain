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
  /** Occlusion, roughness, metalness, and the surface height in alpha. */
  arm: DataTexture
  /** Metres spanned by one tile of the bake. */
  physicalWidth: number
  /** Peak-to-trough relief in metres. */
  reliefDepth: number
  /** Resolves when the fast preview bake has been uploaded. */
  previewReady: Promise<void>
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

function createSolidPixels(
  rgba: readonly [number, number, number, number?],
  size: number,
): Uint8Array {
  const pixels = new Uint8Array(size * size * 4)
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = rgba[0]
    pixels[offset + 1] = rgba[1]
    pixels[offset + 2] = rgba[2]
    // The ARM placeholder carries a mid height in alpha; every other map wants
    // an opaque one. See `packArm`.
    pixels[offset + 3] = rgba[3] ?? 255
  }
  return pixels
}

function createPlaceholder(
  rgba: readonly [number, number, number, number?],
  name: string,
  colorSpace: ColorSpace,
): DataTexture {
  const texture = new DataTexture(
    createSolidPixels(rgba, FULL_SIZE),
    FULL_SIZE,
    FULL_SIZE,
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
  // Match the image-texture convention used by the previous JPG maps. The
  // recipes author runoff and ledge dust with decreasing V as world-up.
  texture.flipY = true
  texture.needsUpdate = true
  return texture
}

function upload(texture: DataTexture, data: Uint8Array, size: number): void {
  const image = texture.image as {
    data: Uint8Array
    width: number
    height: number
  }
  if (
    size !== image.width ||
    size !== image.height ||
    data.byteLength !== image.width * image.height * 4
  ) {
    throw new Error(
      `${texture.name} received ${size}x${size} data for its fixed ` +
      `${image.width}x${image.height} GPU allocation`,
    )
  }
  image.data = data
  texture.needsUpdate = true
}

let worker: Worker | null = null
let workerFailed = false

interface PendingBake {
  resolve(reply: ProceduralBakeReply): void
  reject(error: Error): void
}

let nextToken = 1
const pending = new Map<number, PendingBake>()

function failPending(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function failWorker(error: Error): void {
  workerFailed = true
  worker?.terminate()
  worker = null
  failPending(error)
}

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
    worker.onmessage = (event: MessageEvent<ProceduralBakeReply>) => {
      const request = pending.get(event.data.token)
      if (!request) return
      pending.delete(event.data.token)
      request.resolve(event.data)
    }
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault()
      failWorker(new Error(event.message || 'Procedural texture worker failed'))
    }
    worker.onmessageerror = () => {
      failWorker(new Error('Procedural texture worker returned unreadable data'))
    }
  } catch {
    // Older bundlers and non-browser hosts: fall back to the placeholder.
    workerFailed = true
    worker = null
  }
  return worker
}

function bakeInWorker(
  id: ProceduralSurfaceId,
  size: number,
  outputSize: number,
  seed: number,
): Promise<ProceduralBakeReply> | null {
  const instance = getWorker()
  if (!instance) return null
  const token = nextToken
  nextToken += 1
  const request: ProceduralBakeRequest = { id, size, outputSize, seed, token }
  return new Promise<ProceduralBakeReply>((resolve, reject) => {
    pending.set(token, { resolve, reject })
    try {
      instance.postMessage(request)
    } catch (cause) {
      pending.delete(token)
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })
}

function applyReply(target: ProceduralSurfaceTextures, reply: ProceduralBakeReply): void {
  upload(target.albedo, new Uint8Array(reply.albedo), reply.size)
  upload(target.normal, new Uint8Array(reply.normal), reply.size)
  upload(target.arm, new Uint8Array(reply.arm), reply.size)
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
    arm: createPlaceholder([255, 230, 0, 128], `${id} procedural ARM`, NoColorSpace),
    physicalWidth: recipe.physicalWidth,
    reliefDepth: recipe.reliefDepth,
    previewReady: Promise.resolve(),
    ready: Promise.resolve(),
  }
  cache.set(id, entry)

  const preview = bakeInWorker(id, PREVIEW_SIZE, FULL_SIZE, seed)
  if (preview) {
    entry.previewReady = preview.then((reply) => applyReply(entry, reply))
    entry.ready = entry.previewReady.then(async () => {
      const full = bakeInWorker(id, FULL_SIZE, FULL_SIZE, seed)
      if (!full) return
      applyReply(entry, await full)
    })
    // Material construction starts these jobs before React attaches its status
    // handlers. Mark them handled here while preserving the rejecting promises
    // for callers that want to report a failed bake.
    void entry.previewReady.catch(() => undefined)
    void entry.ready.catch(() => undefined)
  }

  return entry
}

/** Test and tooling hook; drops the cache so a fresh bake can be observed. */
export function resetProceduralSurfaceTextures(): void {
  for (const entry of cache.values()) {
    entry.albedo.dispose()
    entry.normal.dispose()
    entry.arm.dispose()
  }
  cache.clear()
  if (worker) {
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    worker.terminate()
  }
  worker = null
  workerFailed = false
  failPending(new Error('Procedural texture cache reset'))
}

export type { ProceduralSurfaceId }
