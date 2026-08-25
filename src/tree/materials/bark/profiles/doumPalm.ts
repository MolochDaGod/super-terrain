import type { BarkProfile } from '../types'

/**
 * Doum-palm stipe: close, staggered petiole-base scars with dry fibre between
 * them.  The low colour contrast is deliberate; the anatomy should be read
 * from broken relief and roughness, not from black painted wicker lines.
 */
export const DOUM_PALM_BARK: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'palm-boots',
  projection: 'axial-uv',
  columns: 10,
  plateAspect: 0.82,
  linkFrequency: [6, 22],
  minorFrequency: [36, 58],
  plateCyclesY: 20,
  furrowHalfWidth: 0.026,
  linkHalfWidth: 0.024,
  furrowDepth: 0.18,
  furrowStrength: 0.64,
  normalStrength: 6.4,
  runtimeNormalScale: 0.96,
  scarAmount: 0,
  lichenAmount: 0.018,
  mossAmount: 0.004,
  grainAmount: 1.05,
  fissureColorStrength: 0.18,
  // The palette carried a fissure-to-crown span of about 0.15 in luminance, so
  // no amount of shading downstream could make the stipe anything but one flat
  // brown: a full sweep of every weathering term in the packer moved the
  // surface less than a scale-to-scale step does on a hardwood. A sunlit boot
  // face and the slot beside it are most of a stop apart in life.
  palette: {
    fissure: [0.09, 0.075, 0.055],
    crown: [0.5, 0.44, 0.335],
    fresh: [0.6, 0.52, 0.385],
    lichen: [0.43, 0.415, 0.34],
    moss: [0.12, 0.15, 0.08],
  },
}
