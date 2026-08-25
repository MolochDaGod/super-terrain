import type { BarkProfile } from '../types'

/**
 * Mature baobab bark: silver-grey to warm grey-brown, mostly smooth at tree
 * scale, with fine shallow creases, healed folds and powdery weathering.
 */
export const BAOBAB_BARK: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'shallow-blocks',
  columns: 22,
  plateAspect: 3.1,
  linkFrequency: [9, 34],
  minorFrequency: [58, 104],
  plateCyclesY: 10,
  transverseFissureStrength: 0.22,
  furrowHalfWidth: 0.055,
  linkHalfWidth: 0.045,
  furrowDepth: 0.17,
  furrowStrength: 0.48,
  normalStrength: 6.4,
  runtimeNormalScale: 0.78,
  scarAmount: 0.28,
  lichenAmount: 0.18,
  mossAmount: 0.015,
  grainAmount: 0.42,
  fissureColorStrength: 0.14,
  palette: {
    fissure: [0.315, 0.305, 0.275],
    crown: [0.515, 0.505, 0.465],
    fresh: [0.475, 0.445, 0.39],
    lichen: [0.59, 0.6, 0.55],
    moss: [0.23, 0.27, 0.17],
  },
}
