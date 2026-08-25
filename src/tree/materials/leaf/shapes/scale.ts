import { clamp01, hash2 } from '../../proceduralNoise'
import type { BladeShape, Venation } from './types'

/**
 * An araucaria scale leaf: a stiff, broad-based triangle that clasps the shoot
 * and ends in a sharp point, thick enough to be almost succulent.
 *
 * Nothing about it is lamina. It is a wedge, and a monkey puzzle's whole
 * character comes from hundreds of those wedges overlapping like roof tiles, so
 * the outline has to stay a wedge — a leaflet or a needle in its place gives a
 * spray of green hairs.
 */
export function scaleShape(aspect: number, variation: number): BladeShape {
  const seed = Math.round(variation * 65_536)
  const belly = 0.9 + hash2(seed, 17, 0x66d1) * 0.3
  const point = 0.62 + hash2(seed, 19, 0x1f4b) * 0.2

  const halfWidth = (u: number): number => {
    if (u < 0 || u > 1) return 0
    // Widest almost at the base, falling nearly linearly to a sharp apex, with
    // a slight convex belly so the edges bow outward rather than ruling flat.
    const fall = Math.pow(clamp01(1 - u), point)
    const bow = 1 + belly * 0.18 * Math.sin(u * Math.PI)
    return Math.max(0, aspect * fall * bow * clamp01(u / 0.05))
  }

  let reach = 0
  for (let step = 0; step <= 32; step += 1) {
    reach = Math.max(reach, halfWidth(step / 32))
  }
  return {
    halfWidth,
    reach,
    stalkHalfWidth: aspect * 0.7,
    veins(u, v): Venation {
      // Parallel veins running the length of the wedge, as a monocot-like leaf
      // has, rather than one rib with branches.
      const span = Math.max(1e-4, halfWidth(u))
      const across = clamp01(Math.abs(v) / span)
      const ribbing = Math.abs(Math.sin(across * 3.5 * Math.PI))
      return {
        midrib: Math.exp(-((v / (aspect * 0.16)) ** 2)),
        lateral: Math.pow(ribbing, 8) * (1 - across * 0.3),
        reticulate: 0,
      }
    },
  }
}
