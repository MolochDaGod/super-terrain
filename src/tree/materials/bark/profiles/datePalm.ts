import type { BarkProfile } from '../types'

/** Weathered date-palm leaf boots: staggered rhombi, not vertical bark fissures. */
export const DATE_PALM_BARK: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'palm-boots',
  projection: 'axial-uv',
  columns: 9,
  plateAspect: 0.9,
  linkFrequency: [6, 24],
  minorFrequency: [32, 64],
  plateCyclesY: 22,
  furrowHalfWidth: 0.03,
  linkHalfWidth: 0.026,
  furrowDepth: 0.19,
  furrowStrength: 0.66,
  normalStrength: 6.2,
  runtimeNormalScale: 0.9,
  scarAmount: 0,
  lichenAmount: 0.025,
  mossAmount: 0.008,
  grainAmount: 1.22,
  fissureColorStrength: 0.2,
  palette: {
    fissure: [0.205, 0.17, 0.125],
    crown: [0.355, 0.295, 0.215],
    fresh: [0.425, 0.345, 0.235],
    lichen: [0.39, 0.385, 0.325],
    moss: [0.12, 0.15, 0.08],
  },
}
