import { clamp, smoothstep } from '../math'
import type { TreeTrunkProfile } from '../speciesCatalog'

/** Radius relative to the authored trunk radius at a normalised height. */
export function trunkRadiusMultiplier(profile: TreeTrunkProfile, t: number): number {
  const u = clamp(t, 0, 1)
  switch (profile) {
    case 'columnar-flared':
      // Tall tropical column with a very localised plate-buttress flare.
      return 0.5 + Math.pow(1 - u, 0.74) * 0.34 + smoothstep(0.18, 0, u) * 0.48
    case 'bottle': {
      // Broad water-storing lower and middle bole, then an abrupt shoulder.
      const shoulder = smoothstep(0.82, 0.48, u)
      const belly = Math.sin(Math.PI * clamp(u / 0.82, 0, 1)) ** 2
      return 0.22 + shoulder * 0.72 + belly * 0.22 + smoothstep(0.14, 0, u) * 0.14
    }
    case 'palm-column':
      // Palms barely taper; the base swells where the root mantle enters.
      return 0.72 + (1 - u) * 0.12 + smoothstep(0.16, 0, u) * 0.28
    case 'dichotomous-succulent':
      return 0.58 + Math.pow(1 - u, 0.8) * 0.34 + smoothstep(0.2, 0, u) * 0.14
    case 'conifer-excurrent':
      // A persistent conifer leader tapers almost to a shoot. Reusing the
      // broadleaf minimum radius leaves a sawn-off mast through the crown.
      return 0.035 + Math.pow(1 - u, 0.62) * 0.965
    case 'giant-conifer':
      // Sequoias combine an enormous local basal flare with a leader that
      // still resolves to a shoot; a tropical column profile leaves a blunt
      // several-metre mast above the crown.
      return 0.025 + Math.pow(1 - u, 0.5) * 0.975 +
        smoothstep(0.2, 0, u) * 0.48
    case 'tapered':
      return 0.42 + Math.pow(1 - u, 0.7) * 0.58
  }
}
