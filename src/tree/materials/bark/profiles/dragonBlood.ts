import type { BarkProfile } from '../types'

/**
 * Fine grey-brown scales on a mature Dracaena cinnabari trunk and forks.
 *
 * Dracaena really is scaled rather than blocked — the trunk is a stack of small
 * papery plates lifting at their lower edge — so it takes the overlapping-scale
 * structure and keeps the shallow relief the old block recipe was reaching for.
 */
export const DRAGON_BLOOD_BARK: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'scaled-plates',
  columns: 10,
  plateAspect: 3.4,
  linkFrequency: [7, 24],
  minorFrequency: [44, 72],
  plateCyclesY: 11,
  furrowHalfWidth: 0.075,
  linkHalfWidth: 0.07,
  furrowDepth: 0.24,
  furrowStrength: 0.6,
  normalStrength: 5.4,
  runtimeNormalScale: 0.6,
  scarAmount: 0.08,
  lichenAmount: 0.045,
  mossAmount: 0.006,
  grainAmount: 0.48,
  fissureColorStrength: 0.2,
  furrowCoverage: 0.16,
  scaleDensity: 2.3,
  scaleAspect: 1.25,
  scaleLift: 0.5,
  chipAmount: 0.5,
  mosaicAmount: 0.95,
  palette: {
    fissure: [0.205, 0.19, 0.165],
    crown: [0.43, 0.405, 0.355],
    fresh: [0.47, 0.405, 0.325],
    lichen: [0.51, 0.515, 0.455],
    moss: [0.17, 0.22, 0.13],
  },
}
