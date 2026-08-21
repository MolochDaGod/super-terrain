/// <reference lib="webworker" />
import { bakeSurface } from './procedural/bake'
import { PROCEDURAL_SURFACES, type ProceduralSurfaceId } from './procedural/materials'

export interface ProceduralBakeRequest {
  id: ProceduralSurfaceId
  size: number
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
  displacement: ArrayBuffer
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
  const { id, size, seed, token } = event.data
  const recipe = PROCEDURAL_SURFACES[id]
  const maps = bakeSurface(recipe, size, seed)
  const reply: ProceduralBakeReply = {
    token,
    id,
    size: maps.size,
    albedo: maps.albedo.buffer as ArrayBuffer,
    normal: maps.normal.buffer as ArrayBuffer,
    arm: maps.arm.buffer as ArrayBuffer,
    displacement: maps.displacement.buffer as ArrayBuffer,
    physicalWidth: maps.physicalWidth,
    reliefDepth: maps.reliefDepth,
  }
  // Transferring avoids a second copy of four megabytes per material.
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(reply, [
    reply.albedo,
    reply.normal,
    reply.arm,
    reply.displacement,
  ])
}
