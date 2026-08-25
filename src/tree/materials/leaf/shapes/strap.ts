import { clamp01, hash2, mix, smooth01 } from '../../proceduralNoise'
import { ribOnly, type BladeShape, type Venation } from './types'

/**
 * A long, narrow, single-ribbed blade: a palm leaflet, an aloe leaf, a needle.
 *
 * One parameterised family covers all of them because they differ only in how
 * abruptly they taper and how far along the blade the widest point sits. What
 * they share is the thing that matters: no lamina to speak of either side of a
 * single strong rib, so the outline carries the whole read and the venation
 * must stay out of the way.
 */
export interface StrapTraits {
  /** Where the blade is widest, 0 = base, 1 = tip. */
  shoulder: number
  /** How sharply it closes at the tip. High is a fine drawn-out point. */
  taper: number
  /** How much the base narrows into its attachment. */
  waist: number
  /** Rib half-width as a fraction of the blade's own half-width. */
  rib: number
  /** Amplitude of the lengthwise buckling a long strap always carries. */
  kink: number
}

export function strapShape(
  aspect: number,
  variation: number,
  traits: StrapTraits,
): BladeShape {
  const seed = Math.round(variation * 65_536)
  // A real strap leaf is never straight-sided: it buckles along its length and
  // the two edges buckle out of step. Perfectly parallel edges are what make a
  // procedural frond leaflet read as a drawn stroke.
  const phase = hash2(seed, 3, 0x71c3) * 6.28
  const rate = 2.4 + hash2(seed, 5, 0x2b19) * 3.2

  const halfWidth = (u: number, side: number): number => {
    if (u < 0 || u > 1) return 0
    const rise = smooth01(u / Math.max(1e-3, traits.waist))
    const fall = Math.pow(clamp01((1 - u) / (1 - traits.shoulder)), 1 / traits.taper)
    const buckle = 1 + Math.sin(u * rate * Math.PI + phase + (side < 0 ? 1.7 : 0)) *
      traits.kink
    return Math.max(0, aspect * rise * Math.min(1, fall) * buckle)
  }

  let reach = 0
  for (let step = 0; step <= 48; step += 1) {
    const u = step / 48
    reach = Math.max(reach, halfWidth(u, 1), halfWidth(u, -1))
  }
  const rib = ribOnly(aspect * traits.rib)
  return {
    halfWidth,
    reach,
    stalkHalfWidth: aspect * 0.5,
    veins(u, v): Venation {
      const base = rib(u, v)
      // The fold a palm leaflet carries along its rib shows as a second, much
      // weaker highlight either side of it.
      return {
        midrib: base.midrib,
        lateral: 0,
        reticulate: clamp01(Math.abs(Math.sin(v / (aspect * 0.5) * Math.PI)) * 0.4),
      }
    },
  }
}

/** Palm leaflet: widest low, drawn out to a long fine point, strongly folded. */
export const PALM_LEAFLET: StrapTraits = {
  shoulder: 0.18, taper: 1.5, waist: 0.06, rib: 0.3, kink: 0.07,
}
/** Aloe or dragon-blood leaf: thick, evenly tapered, barely buckled. */
export const ROSETTE_LEAF: StrapTraits = {
  shoulder: 0.1, taper: 1.05, waist: 0.09, rib: 0.42, kink: 0.025,
}
/** Conifer needle: near parallel-sided with a blunt tip. */
export const NEEDLE: StrapTraits = {
  shoulder: 0.22, taper: 0.42, waist: 0.05, rib: 0.34, kink: 0.02,
}

/** Blends two strap traits, for species between two archetypes. */
export function blendStrap(a: StrapTraits, b: StrapTraits, amount: number): StrapTraits {
  return {
    shoulder: mix(a.shoulder, b.shoulder, amount),
    taper: mix(a.taper, b.taper, amount),
    waist: mix(a.waist, b.waist, amount),
    rib: mix(a.rib, b.rib, amount),
    kink: mix(a.kink, b.kink, amount),
  }
}
