import type { TwigMassProfile } from '../twigMass'

/**
 * Structural ranges for an old African baobab crown.
 *
 * This is deliberately not an ExplicitScaffoldProfile. Baobabs resolve their
 * storage bole into a few unequal trunk-scale divisions and then ramify those
 * divisions repeatedly, ending in a dense fan of short crooked shoots — the
 * "roots in the air" the tree is named for. Treating those divisions as
 * independent radial limbs is what produced the rejected vase-and-tubes
 * silhouette, and hanging leaf cards straight off them is what made the crown
 * read as confetti.
 */
export interface BaobabCrownProfile {
  /** Heavy divisions leaving the upper bole, including its continuation. */
  divisionCount: readonly [number, number]
  /** Height band on the bole the non-continuation divisions leave from. */
  divisionAttachment: readonly [number, number]
  divisionLength: readonly [number, number]
  /** Initial climb of a division, as a tangent above horizontal. */
  divisionRise: readonly [number, number]
  /** Division base radius as a fraction of the bole radius where it leaves. */
  divisionRadius: readonly [number, number]
  /** How much longer the dominant division is than the weakest. */
  divisionVigor: readonly [number, number]
  /** Recursive woody orders after the initial divisions. */
  ramificationDepth: number
  continuationOpening: readonly [number, number]
  lateralOpening: readonly [number, number]
  daughterRadius: readonly [number, number]
  lateralRadius: readonly [number, number]
  lengthDecay: readonly [number, number]
  /** Probability a lateral simply never survived, rising with order. */
  lossProbability: number
  /**
   * How readily a weakened axis stops ramifying and flowers into shoots.
   *
   * This is what puts leaf mass inside the crown rather than only on its shell.
   */
  exhaustion: number
  /**
   * How strongly each order levels off. 0 keeps a limb climbing at its parent's
   * bearing; 1 turns it fully horizontal within one order.
   */
  levelling: readonly [number, number]
  terminalRadius: number
  twigs: TwigMassProfile
}

export const BAOBAB_CROWN_PROFILE: BaobabCrownProfile = {
  divisionCount: [5, 6],
  // A band, not a ring. Real divisions leave the shoulder over more than a
  // metre of height, which is most of what stops the fork reading as a hub.
  divisionAttachment: [0.9, 1],
  divisionLength: [0.4, 0.56],
  // Steep. The rejected render had these leaving almost horizontally, so the
  // crown was a flat starburst with no height of its own.
  divisionRise: [0.95, 1.9],
  divisionRadius: [0.48, 0.7],
  divisionVigor: [0.62, 1],
  ramificationDepth: 4,
  continuationOpening: [0.16, 0.38],
  lateralOpening: [0.58, 1.08],
  daughterRadius: [0.72, 0.84],
  lateralRadius: [0.46, 0.64],
  lengthDecay: [0.58, 0.73],
  lossProbability: 0.14,
  exhaustion: 0.62,
  levelling: [0.18, 0.52],
  terminalRadius: 0.026,
  twigs: {
    twigCount: [4, 7],
    twigLength: [0.7, 1.5],
    twigRadius: [0.5, 0.78],
    spread: [0.5, 1.25],
    stations: [3, 5],
    massRadius: [0.34, 0.58],
    organRadius: [0.4, 0.62],
    organDepth: [0.44, 0.68],
    organModel: 'broadleaf-spray',
  },
}
