import type { LeafPlacement, LeafProfile, ShootSegment } from '../types'

/** What one card's layout produces: the woody skeleton and the blades on it. */
export interface SprayLayout {
  leaves: LeafPlacement[]
  shoots: ShootSegment[]
}

/**
 * Content keeps clear of the card border by this fraction. A blade that runs
 * off the edge is cut by a dead-straight line in the crown, and straight cuts
 * through foliage are one of the loudest artefacts a canopy can have.
 */
export const MARGIN = 0.055

export type LayoutBuilder = (
  random: () => number,
  variant: number,
  profile: LeafProfile,
) => SprayLayout

/** Shared blade defaults, so each layout only states what it actually varies. */
export function placeBlade(
  profile: LeafProfile,
  random: () => number,
  overrides: Partial<LeafPlacement> & Pick<LeafPlacement, 'x' | 'y' | 'angle' | 'length'>,
): LeafPlacement {
  return {
    width: profile.aspect,
    // How far the blade is tilted out of the card plane. The distribution has
    // to stay weighted toward face-on: sampling uniformly and squaring it put
    // the mean near a half, which turns a leafy twiglet into splinters.
    squash: mix01(0.22, 1, Math.pow(random(), 0.45)),
    pigment: 0.9 + random() * 0.2,
    variation: random(),
    depth: random(),
    curl: (random() - 0.5) * 1.5,
    petiole: 0.07 + random() * 0.06,
    ...overrides,
  }
}

function mix01(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}
