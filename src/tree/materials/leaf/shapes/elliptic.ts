import { clamp01, hash2, mix, smooth01 } from '../../proceduralNoise'
import type { BladeShape, Venation } from './types'

/**
 * An entire-margined elliptic leaflet with pinnate venation: the leaflet of a
 * ceiba or a baobab, and the general-purpose "simple leaf" shape.
 *
 * It is the opposite problem to the oak. There are no lobes at all, so the
 * outline gives the eye almost nothing and the *venation* has to carry the
 * read: a strong rib with a dozen secondaries curving forward and meeting near
 * the margin. Drawn without them, a leaflet is an anonymous green ellipse.
 */
export function ellipticShape(
  aspect: number,
  variation: number,
  /** How far above the base the blade is widest. Above a half is obovate. */
  shoulder = 0.46,
  /** How drawn-out the apex is. */
  acumen = 0.62,
): BladeShape {
  const seed = Math.round(variation * 65_536)
  const veinPairs = 6 + Math.floor(hash2(seed, 23, 0x4c81) * 5)
  const lean = (hash2(seed, 29, 0x11ab) - 0.5) * 0.16

  const halfWidth = (u: number, side: number): number => {
    if (u < 0 || u > 1) return 0
    // A skewed ellipse: the sine puts a rounded base and apex on it, and the
    // exponent slides the widest point without introducing a corner.
    const body = Math.sin(Math.PI * Math.pow(clamp01(u), Math.log(0.5) / Math.log(shoulder)))
    const apex = Math.pow(clamp01((1.02 - u) / 0.34), acumen)
    // The two halves of a real leaflet are slightly unequal; the base
    // especially is often frankly oblique.
    const skew = 1 + lean * side * smooth01((0.4 - u) / 0.4)
    return Math.max(0, aspect * body * Math.min(1, apex) * skew)
  }

  let reach = 0
  for (let step = 0; step <= 48; step += 1) {
    const u = step / 48
    reach = Math.max(reach, halfWidth(u, 1), halfWidth(u, -1))
  }
  return {
    halfWidth,
    reach,
    stalkHalfWidth: aspect * 0.075,
    veins(u, v, side): Venation {
      const ribWidth = aspect * mix(0.07, 0.026, u)
      const midrib = Math.exp(-((v / ribWidth) ** 2))
      let lateral = 0
      for (let index = 0; index < veinPairs; index += 1) {
        // Secondaries leave the rib at even intervals and arch forward, each
        // one turning to run parallel to the margin before it reaches it.
        const root = 0.08 + (index + (side < 0 ? 0.5 : 0)) / (veinPairs + 0.5) * 0.84
        const apex = Math.min(0.97, root + 0.2)
        const t = clamp01((u - root) / Math.max(1e-3, apex - root))
        const tip = halfWidth(apex, side) * 0.86
        const line = Math.pow(t, 0.62) * tip * Math.sign(v || 1)
        const thickness = aspect * mix(0.038, 0.016, t)
        const live = smooth01((u - root + 0.05) / 0.05) *
          smooth01((apex + 0.08 - u) / 0.08)
        lateral = Math.max(
          lateral, Math.exp(-(((v - line) / thickness) ** 2)) * live,
        )
      }
      const across = clamp01(Math.abs(v) / Math.max(1e-4, halfWidth(u, side)))
      const cross = Math.sin((u * 55 + across * 15) * Math.PI) *
        Math.sin((u * 23 - across * 33) * Math.PI)
      return {
        midrib,
        lateral,
        reticulate: clamp01(Math.abs(cross) * (1 - midrib) * (1 - lateral)),
      }
    },
  }
}
