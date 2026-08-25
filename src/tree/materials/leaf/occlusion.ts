import { clamp01 } from '../proceduralNoise'
import type { SprayFields } from './types'

/**
 * Card-local ambient occlusion, measured from the rasterised spray itself.
 *
 * A leaf card is one flat plane standing in for a twiglet carrying twenty
 * blades at twenty different depths. The mutual shadowing those blades cast on
 * each other is a fact of that geometry, but the geometry is not there, so no
 * renderer can produce it: a lit card comes back uniformly bright from rim to
 * core and the spray reads as a printed decal. Baking it is not double-shading
 * — it is supplying occlusion for geometry the card replaces — provided it goes
 * to the ambient term and never into albedo.
 *
 * Two cues combine. Density says how much foliage surrounds a texel, at a near
 * scale for blade-on-blade contact and a far scale for the mass of the spray as
 * a whole. Recess says how far the visible surface sits behind the frontmost
 * blade nearby, which is what darkens a leaf lying under the canopy of its own
 * twig while leaving the outermost blades open to the sky.
 */
const OCCLUSION_FLOOR = 0.44

export function bakeCardOcclusion(fields: SprayFields): Float32Array {
  const { size, alpha, depthBuffer } = fields
  const near = boxBlur(alpha, size, 5)
  const far = boxBlur(alpha, size, 17)
  const frontmost = maxBlur(depthBuffer, size, 9)
  const occlusion = new Float32Array(size * size)
  for (let index = 0; index < occlusion.length; index += 1) {
    if (alpha[index]! <= 0.02) {
      occlusion[index] = 1
      continue
    }
    const recess = clamp01(frontmost[index]! - depthBuffer[index]!)
    // Weak, and floored. Ambient occlusion is a contact term: it should deepen
    // the crevices between overlapping blades, not act as a second exposure
    // control on the whole card. The first calibration put the median texel at
    // less than half ambient, which turned every spray the sun could not reach
    // into a black cutout — the exact artefact this map exists to avoid.
    occlusion[index] = Math.max(
      OCCLUSION_FLOOR,
      clamp01(1 - near[index]! * 0.14 - far[index]! * 0.13 - recess * 0.4),
    )
  }
  return occlusion
}

/** Separable box blur with clamped edges. */
function boxBlur(source: Float32Array, size: number, radius: number): Float32Array {
  const horizontal = new Float32Array(size * size)
  const result = new Float32Array(size * size)
  const span = radius * 2 + 1
  for (let y = 0; y < size; y += 1) {
    const row = y * size
    let total = 0
    for (let x = -radius; x <= radius; x += 1) total += source[row + clampIndex(x, size)]!
    for (let x = 0; x < size; x += 1) {
      horizontal[row + x] = total / span
      total += source[row + clampIndex(x + radius + 1, size)]! -
        source[row + clampIndex(x - radius, size)]!
    }
  }
  for (let x = 0; x < size; x += 1) {
    let total = 0
    for (let y = -radius; y <= radius; y += 1) {
      total += horizontal[clampIndex(y, size) * size + x]!
    }
    for (let y = 0; y < size; y += 1) {
      result[y * size + x] = total / span
      total += horizontal[clampIndex(y + radius + 1, size) * size + x]! -
        horizontal[clampIndex(y - radius, size) * size + x]!
    }
  }
  return result
}

/** Separable maximum filter: the nearest blade anywhere in the neighbourhood. */
function maxBlur(source: Float32Array, size: number, radius: number): Float32Array {
  const horizontal = new Float32Array(size * size)
  const result = new Float32Array(size * size)
  const deque = new Int32Array(size)
  for (let y = 0; y < size; y += 1) {
    const row = y * size
    let head = 0
    let tail = 0
    let added = -1
    for (let x = 0; x < size; x += 1) {
      const right = Math.min(size - 1, x + radius)
      while (added < right) {
        added += 1
        const value = source[row + added]!
        while (tail > head && source[row + deque[tail - 1]!]! <= value) tail -= 1
        deque[tail++] = added
      }
      const left = Math.max(0, x - radius)
      while (tail > head && deque[head]! < left) head += 1
      horizontal[row + x] = source[row + deque[head]!]!
    }
  }
  for (let x = 0; x < size; x += 1) {
    let head = 0
    let tail = 0
    let added = -1
    for (let y = 0; y < size; y += 1) {
      const bottom = Math.min(size - 1, y + radius)
      while (added < bottom) {
        added += 1
        const value = horizontal[added * size + x]!
        while (
          tail > head && horizontal[deque[tail - 1]! * size + x]! <= value
        ) {
          tail -= 1
        }
        deque[tail++] = added
      }
      const top = Math.max(0, y - radius)
      while (tail > head && deque[head]! < top) head += 1
      result[y * size + x] = horizontal[deque[head]! * size + x]!
    }
  }
  return result
}

function clampIndex(value: number, size: number): number {
  return value < 0 ? 0 : value >= size ? size - 1 : value
}
