import type { BarkProfile } from '../types'

/** Smooth grey-tan coconut stipe with interrupted annular leaf scars. */
export const COCONUT_PALM_BARK: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'palm-rings',
  projection: 'axial-uv',
  columns: 13,
  plateAspect: 4,
  linkFrequency: [4, 14],
  minorFrequency: [32, 48],
  plateCyclesY: 17,
  furrowHalfWidth: 0.045,
  linkHalfWidth: 0.025,
  furrowDepth: 0.14,
  furrowStrength: 0.84,
  normalStrength: 7.5,
  runtimeNormalScale: 1.02,
  scarAmount: 0,
  lichenAmount: 0.015,
  mossAmount: 0.004,
  grainAmount: 0.9,
  fissureColorStrength: 0.08,
  palette: {
    fissure: [0.18, 0.155, 0.115],
    crown: [0.37, 0.33, 0.26],
    fresh: [0.42, 0.36, 0.265],
    lichen: [0.4, 0.405, 0.35],
    moss: [0.12, 0.145, 0.08],
  },
}
