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
  // The palette carried a fissure-to-crown span of about 0.15 in luminance, so
  // no amount of shading downstream could make the stipe anything but one flat
  // brown: a full sweep of every weathering term in the packer moved the
  // surface less than a scale-to-scale step does on a hardwood. A sunlit boot
  // face and the slot beside it are most of a stop apart in life.
  palette: {
    fissure: [0.085, 0.068, 0.05],
    crown: [0.52, 0.45, 0.34],
    fresh: [0.63, 0.545, 0.4],
    lichen: [0.39, 0.385, 0.325],
    moss: [0.12, 0.15, 0.08],
  },
}
