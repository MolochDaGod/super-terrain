import { ellipticShape } from './shapes/elliptic'
import { lobedShape } from './shapes/lobed'
import { pinnuleShape } from './shapes/pinnule'
import { scaleShape } from './shapes/scale'
import { NEEDLE, PALM_LEAFLET, ROSETTE_LEAF, strapShape } from './shapes/strap'
import type { LeafProfile } from './types'

export type { BladeShape, Venation } from './shapes/types'

/**
 * Routes a species to its blade outline.
 *
 * Every family gets its own generator rather than a reparameterised oak,
 * because outline and arrangement are not separable: a palm leaflet is a long
 * strap precisely because a hundred of them are ranked along a three-metre
 * rachis. Squashing a lobed blade into that slot is what turns a date palm's
 * crown into a spray of thin green spikes.
 */
export function makeBladeShape(
  profile: LeafProfile,
  variation: number,
  aspect: number,
) {
  switch (profile.family) {
    case 'needle-fascicle':
      return strapShape(aspect, variation, NEEDLE)
    case 'pinnate-frond':
      return strapShape(aspect, variation, PALM_LEAFLET)
    case 'rosette':
      return strapShape(aspect, variation, ROSETTE_LEAF)
    case 'fern-frond':
      return pinnuleShape(aspect, variation)
    case 'scale-spray':
      return scaleShape(aspect, variation)
    case 'palmate':
      return ellipticShape(aspect, variation, 0.5, 0.55)
    case 'broadleaf-simple':
      // Widest below the middle and drawn out to a soft point: the ovate blade
      // of a fig or a banyan, whose whole read is its venation rather than its
      // outline, since it has no lobes or teeth at all.
      return ellipticShape(aspect, variation, 0.42, 0.7)
    default:
      return lobedShape(variation, aspect, profile.lobePairs)
  }
}
