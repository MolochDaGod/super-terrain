import type { Vec3Like } from '../core/types'
import type { BrushSample } from './types'

const MAX_SAMPLES_PER_POINTER_EVENT = 32

/** Produces event-rate-independent samples for one continuous brush stroke. */
export function sampleStrokeSegment(
  from: Vec3Like,
  to: Vec3Like,
  fromNormal: Vec3Like,
  toNormal: Vec3Like,
  spacing: number,
  sampleWeight = 1,
): BrushSample[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const distance = Math.hypot(dx, dy, dz)
  const rawCount = Math.floor(distance / Math.max(0.001, spacing))
  if (rawCount === 0) return []
  const count = Math.min(rawCount, MAX_SAMPLES_PER_POINTER_EVENT)
  // A fast drag can cover more than the cap allows. Spreading the dabs it did
  // earn across the whole segment and thickening each one by what was dropped
  // keeps a quick pass depositing the same material as a slow one.
  const weight = (sampleWeight * rawCount) / count
  const samples: BrushSample[] = []

  for (let index = 1; index <= count; index += 1) {
    const t =
      rawCount > MAX_SAMPLES_PER_POINTER_EVENT
        ? index / count
        : Math.min(1, (index * spacing) / distance)
    samples.push({
      x: from.x + dx * t,
      y: from.y + dy * t,
      z: from.z + dz * t,
      normal: normalizedLerp(fromNormal, toNormal, t),
      weight,
    })
  }
  return samples
}

function normalizedLerp(from: Vec3Like, to: Vec3Like, t: number): Vec3Like {
  const x = from.x + (to.x - from.x) * t
  const y = from.y + (to.y - from.y) * t
  const z = from.z + (to.z - from.z) * t
  const length = Math.hypot(x, y, z) || 1
  return { x: x / length, y: y / length, z: z / length }
}
