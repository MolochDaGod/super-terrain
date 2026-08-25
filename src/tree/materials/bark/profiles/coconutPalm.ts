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
  // The palette carried a fissure-to-crown span of about 0.15 in luminance, so
  // no amount of shading downstream could make the stipe anything but one flat
  // brown: a full sweep of every weathering term in the packer moved the
  // surface less than a scale-to-scale step does on a hardwood. A sunlit boot
  // face and the slot beside it are most of a stop apart in life.
  palette: {
    fissure: [0.1, 0.092, 0.078],
    crown: [0.55, 0.525, 0.46],
    fresh: [0.63, 0.585, 0.5],
    lichen: [0.4, 0.405, 0.35],
    moss: [0.12, 0.145, 0.08],
  },
}
