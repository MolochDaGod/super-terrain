import type { BarkProfile } from '../types'

/**
 * Mature live-oak bark: close, irregular grey-brown blocks separated by
 * shallow branching fissures.  It is deliberately its own recipe rather than
 * an alias of English oak.  Live-oak plates are hand-scale and comparatively
 * low-contrast; stretching seven rows over a 3.2 m tile turns them into long
 * routed grooves once the map is wrapped around a branch.
 */
export const LIVE_OAK_BARK: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'shallow-blocks',
  columns: 18,
  plateAspect: 1.35,
  linkFrequency: [9, 38],
  minorFrequency: [56, 104],
  plateCyclesY: 24,
  transverseFissureStrength: 0.42,
  furrowHalfWidth: 0.09,
  linkHalfWidth: 0.18,
  furrowDepth: 0.095,
  furrowStrength: 0.52,
  normalStrength: 6.2,
  scarAmount: 0.1,
  lichenAmount: 0.22,
  mossAmount: 0.12,
  grainAmount: 0.72,
  fissureColorStrength: 0.38,
  palette: {
    fissure: [0.245, 0.238, 0.22],
    crown: [0.355, 0.36, 0.345],
    fresh: [0.385, 0.375, 0.35],
    lichen: [0.45, 0.47, 0.435],
    moss: [0.21, 0.25, 0.17],
  },
}
