/// <reference lib="webworker" />
import { bakeSurface } from './procedural/bake'
import { PROCEDURAL_SURFACES, type ProceduralSurfaceId } from './procedural/materials'
import { resizeRgbaNearest } from './procedural/resample'

export interface ProceduralBakeRequest {
  id: ProceduralSurfaceId
  /** Resolution at which the procedural recipe is evaluated. */
  size: number
  /** Fixed GPU allocation size; preview results are expanded to this size. */
  outputSize?: number
  seed: number
  /** Echoed back so the host can match a reply to its request. */
  token: number
}

export interface ProceduralBakeReply {
  token: number
  id: ProceduralSurfaceId
  size: number
  albedo: ArrayBuffer
  normal: ArrayBuffer
  arm: ArrayBuffer
  physicalWidth: number
  reliefDepth: number
}

/**
 * Bakes a procedural surface off the main thread.
 *
 * The work is a few seconds of tight numeric loops. Running it here keeps the
 * first frame interactive; the host binds placeholder textures immediately and
 * swaps the real pixels in when they arrive.
 */
self.onmessage = (event: MessageEvent<ProceduralBakeRequest>) => {
  const { id, size, outputSize = size, seed, token } = event.data
  const recipe = PROCEDURAL_SURFACES[id]
  const maps = bakeSurface(recipe, size, seed)
  const albedo = resizeRgbaNearest(maps.albedo, maps.size, outputSize)
  const normal = resizeRgbaNearest(maps.normal, maps.size, outputSize)
  const arm = resizeRgbaNearest(maps.arm, maps.size, outputSize)
  const reply: ProceduralBakeReply = {
    token,
    id,
    size: outputSize,
    albedo: albedo.buffer as ArrayBuffer,
    normal: normal.buffer as ArrayBuffer,
    arm: arm.buffer as ArrayBuffer,
    physicalWidth: maps.physicalWidth,
    reliefDepth: maps.reliefDepth,
  }
  // Transferring avoids a second copy of three megabytes per material.
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(reply, [
    reply.albedo,
    reply.normal,
    reply.arm,
  ])
}
