import type { BarkProfile } from '../types'

/** Fine grey-brown scales on a mature Dracaena cinnabari trunk and forks. */
export const DRAGON_BLOOD_BARK: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'shallow-blocks',
  columns: 18,
  plateAspect: 1.45,
  linkFrequency: [7, 24],
  minorFrequency: [44, 72],
  plateCyclesY: 11,
  furrowHalfWidth: 0.075,
  linkHalfWidth: 0.07,
  furrowDepth: 0.22,
  furrowStrength: 0.58,
  normalStrength: 6.6,
  runtimeNormalScale: 0.78,
  scarAmount: 0.08,
  lichenAmount: 0.045,
  mossAmount: 0.006,
  grainAmount: 0.48,
  fissureColorStrength: 0.2,
  palette: {
    fissure: [0.205, 0.19, 0.165],
    crown: [0.43, 0.405, 0.355],
    fresh: [0.47, 0.405, 0.325],
    lichen: [0.51, 0.515, 0.455],
    moss: [0.17, 0.22, 0.13],
  },
}
