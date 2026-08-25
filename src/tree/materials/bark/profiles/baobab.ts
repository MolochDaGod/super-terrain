import type { BarkProfile } from '../types'

/**
 * Mature baobab bark: silver-grey to warm grey-brown, essentially smooth at
 * tree scale, with healed folds, shallow stretch creases and a powdery bloom.
 *
 * It ran on the block structure, which gave a bark famous for being polished a
 * network of cork plates it does not have. What it does have is broad tonal
 * mottling over a swelling surface, which is what the smooth structure builds.
 */
export const BAOBAB_BARK: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'mottled-smooth',
  columns: 6,
  plateAspect: 2.4,
  linkFrequency: [9, 34],
  minorFrequency: [58, 104],
  plateCyclesY: 4,
  transverseFissureStrength: 0.22,
  furrowHalfWidth: 0.055,
  linkHalfWidth: 0.045,
  furrowDepth: 0.07,
  furrowStrength: 0.22,
  normalStrength: 3.4,
  runtimeNormalScale: 0.5,
  scarAmount: 0.28,
  lichenAmount: 0.18,
  mossAmount: 0.015,
  grainAmount: 0.42,
  fissureColorStrength: 0.14,
  scaleDensity: 2.2,
  scaleAspect: 2.6,
  scaleLift: 0.14,
  mosaicAmount: 0.5,
  palette: {
    fissure: [0.315, 0.305, 0.275],
    crown: [0.515, 0.505, 0.465],
    fresh: [0.475, 0.445, 0.39],
    lichen: [0.59, 0.6, 0.55],
    moss: [0.23, 0.27, 0.17],
  },
}
