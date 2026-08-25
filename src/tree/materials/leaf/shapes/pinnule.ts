import { clamp01, hash2, smooth01 } from '../../proceduralNoise'
import type { BladeShape, Venation } from './types'

/**
 * A fern pinnule: a small oblong blade, blunt-tipped, with shallow rounded
 * teeth down both margins and a single rib with short side veins.
 *
 * The teeth are the identity. A fern frond at any distance is thousands of
 * these, and if each one is a smooth ellipse the frond reads as a feather duster
 * — the finely serrated edge is what makes the mass look like a fern.
 */
export function pinnuleShape(aspect: number, variation: number): BladeShape {
  const seed = Math.round(variation * 65_536)
  const teeth = 4 + Math.floor(hash2(seed, 11, 0x33a7) * 4)
  const bite = 0.1 + hash2(seed, 13, 0x51bd) * 0.09

  const halfWidth = (u: number, side: number): number => {
    if (u < 0 || u > 1) return 0
    // Oblong: rises quickly, holds, then rounds off. Not a taper to a point.
    const body = smooth01(u / 0.16) * smooth01((1.04 - u) / 0.3)
    const phase = side < 0 ? 0.5 : 0
    const serration = 1 - bite *
      (0.5 - 0.5 * Math.cos((u * teeth + phase) * Math.PI * 2))
    return Math.max(0, aspect * body * serration)
  }

  let reach = 0
  for (let step = 0; step <= 48; step += 1) {
    const u = step / 48
    reach = Math.max(reach, halfWidth(u, 1), halfWidth(u, -1))
  }
  return {
    halfWidth,
    reach,
    stalkHalfWidth: aspect * 0.22,
    veins(u, v, side): Venation {
      const midrib = Math.exp(-((v / (aspect * 0.14)) ** 2))
      // One short vein into each tooth.
      let lateral = 0
      for (let index = 0; index < teeth; index += 1) {
        const apex = (index + (side < 0 ? 0.5 : 0) + 0.5) / teeth
        const t = clamp01((u - (apex - 0.12)) / 0.12)
        const line = t * halfWidth(apex, side) * 0.9 * Math.sign(v || 1)
        const live = smooth01((u - apex + 0.16) / 0.06) *
          smooth01((apex + 0.06 - u) / 0.06)
        lateral = Math.max(
          lateral,
          Math.exp(-(((v - line) / (aspect * 0.09)) ** 2)) * live,
        )
      }
      return { midrib, lateral, reticulate: 0 }
    },
  }
}
