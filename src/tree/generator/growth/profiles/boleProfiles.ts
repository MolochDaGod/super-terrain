import { clamp, hashUnit, lerpNumber, smoothstep } from '../../math'
import type { TreeSpecies } from '../../speciesCatalog'

/**
 * Species bole character, as a profile rather than a branch in the trunk code.
 *
 * `trunkRadiusMultiplier` gives every species one of seven revolved silhouettes
 * and nothing else, which is why review kept describing these boles as perfect
 * extruded cylinders with a generic basal bulge. A real bole differs from its
 * neighbours in four independent ways — how it meanders, how unevenly it
 * tapers, how it meets the ground, and what history is legible on it — and all
 * four have to be authored per species or they cannot be varied per species.
 *
 * This is deliberately a *path and girth* description. Surface pattern is the
 * bark maps' business; what belongs here is the shape a silhouette sees.
 */
export interface BoleProfile {
  /**
   * Sideways wander of the centre line, in trunk radii, and how many turns it
   * makes over the bole. A perfectly straight axis is the single strongest
   * "extruded" cue there is.
   */
  meander: readonly [number, number]
  meanderTurns: number
  /**
   * Irregular girth variation along the bole, as a fraction of the radius, and
   * its wavelength in bole fractions. This is the swelling and waisting that a
   * revolved profile curve cannot express.
   */
  swelling: number
  swellingWaves: number
  /** Extra girth right at the ground line, as a fraction of the radius. */
  foot: number
  /** How far the foot flare reaches up, in trunk radii. */
  footReach: number
  /**
   * Girth at the top of the bole relative to its widest, before any flare.
   * Low values hand a slender stem to the crown; high values keep it massive.
   */
  handover: number
  /** How abruptly the taper happens: 1 is linear, above 1 holds girth longer. */
  taperHold: number
  /**
   * Persistent leaf-base relief, as a fraction of the radius, and how many rows
   * of it there are per metre.
   *
   * This is *anisotropic* surface structure: it is handed to the ring builder's
   * leaf-base mechanism, which places discrete lips around the circumference.
   * Adding it to the radius instead produced a positive full-ring band at every
   * row — a stack of sausages with a cusp at each zero crossing, which is what
   * plan review found on the Joshua bole.
   */
  nodeRelief: number
  nodesPerMetre: number
}

/** Neutral character, exported for species that want a starting point. */
export const STRAIGHT_COLUMN: BoleProfile = {
  meander: [0.1, 0.28],
  meanderTurns: 1.1,
  swelling: 0.05,
  swellingWaves: 2.2,
  foot: 0.3,
  footReach: 1.4,
  handover: 0.62,
  taperHold: 1.15,
  nodeRelief: 0,
  nodesPerMetre: 0,
}

const PROFILES: Partial<Record<TreeSpecies, BoleProfile>> = {
  // Dracaena: a short, heavy, visibly uneven bole that flares *upward* into the
  // first division rather than tapering away from it.
  'dragon-blood': {
    meander: [0.1, 0.24],
    meanderTurns: 0.85,
    swelling: 0.055,
    swellingWaves: 1.45,
    foot: 0.42,
    footReach: 1.9,
    handover: 0.94,
    taperHold: 1.6,
    nodeRelief: 0,
    nodesPerMetre: 0,
  },
  // Aloidendron: stout, strongly waisted, with a wide skirted base.
  'quiver-tree': {
    meander: [0.1, 0.28],
    meanderTurns: 0.7,
    swelling: 0.065,
    swellingWaves: 1.35,
    foot: 0.55,
    footReach: 2.2,
    handover: 0.7,
    taperHold: 1.25,
    nodeRelief: 0,
    nodesPerMetre: 0,
  },
  // Yucca brevifolia: crooked, unevenly thick, and covered in leaf-base nodes.
  'joshua-tree': {
    meander: [0.12, 0.34],
    meanderTurns: 1.15,
    swelling: 0.06,
    swellingWaves: 1.6,
    foot: 0.34,
    footReach: 1.5,
    handover: 0.82,
    taperHold: 1.5,
    // Leaf-base armour is anisotropic surface anatomy. Applying it to the
    // complete ring made the trunk a stack of sausages; retained boots and the
    // bark profile own that signal instead.
    nodeRelief: 0,
    nodesPerMetre: 0,
  },
  // Hyphaene: a clean palm stipe with ring scars, barely tapering, leaning.
  'doum-palm': {
    meander: [0.12, 0.3],
    meanderTurns: 0.75,
    swelling: 0.025,
    swellingWaves: 1.2,
    foot: 0.28,
    footReach: 1.2,
    handover: 0.9,
    taperHold: 2.2,
    nodeRelief: 0,
    nodesPerMetre: 0,
  },
}

export function boleProfile(species: TreeSpecies): BoleProfile | undefined {
  return PROFILES[species]
}

export interface BoleStation {
  /** Girth multiplier against the authored trunk radius. */
  radiusMultiplier: number
  /** Sideways offset of the centre line, in metres, in the meander plane. */
  offset: number
  /** Cross-tie offset, so the axis corkscrews rather than bending in a plane. */
  crossOffset: number
}

/**
 * Evaluates a species bole at a normalised height.
 *
 * `metresAboveGrade` is passed separately because the flare that matters is the
 * one a standing player sees, and a bole whose butt is buried has most of a
 * height-normalised flare below the soil.
 */
export function boleStation(
  profile: BoleProfile,
  t: number,
  metresAboveGrade: number,
  trunkRadius: number,
  seed: number,
  age: number,
  /** Bole height, used to bound centre-line curvature against the girth. */
  boleHeight = 0,
): BoleStation {
  const u = clamp(t, 0, 1)
  const identity = hashUnit(seed ^ 0x2f6e1c47, 1.13, 0.71, 2.9)
  const second = hashUnit(seed ^ 0x77a3b915, 0.41, 2.17, 1.06)

  // Girth: hold most of it, then hand over. `taperHold` above one keeps the
  // bole massive right up to the division, which is what a species that forks
  // into trunk-scale limbs needs and what a linear taper cannot give.
  const taper = 1 - Math.pow(u, profile.taperHold)
  const column = lerpNumber(profile.handover, 1, taper)
  // Two incommensurate low-frequency waves. Everything here is a smooth
  // function of `u`, so the girth field is C1 along the whole bole: a stack of
  // discrete swellings reads as balloons threaded on a wire, and any cusp in
  // the field becomes a hard circumferential ring on the surface.
  const swelling = profile.swelling * (
    Math.sin(u * Math.PI * profile.swellingWaves + identity * 6.1) * 0.62 +
    Math.sin(u * Math.PI * profile.swellingWaves * 1.41 + second * 4.4) * 0.38
  ) * Math.sin(Math.min(1, u * 1.35) * Math.PI)
  const foot = profile.foot * Math.pow(
    smoothstep(trunkRadius * profile.footReach, -trunkRadius * 0.6, metresAboveGrade),
    1.35,
  ) * lerpNumber(0.8, 1.15, age)

  // A swept tube folds through itself once the centre line's curvature exceeds
  // its own radius. For a sinusoid of amplitude A over a bole of height H with
  // `turns` waves, the peak curvature is A(2*pi*turns/H)^2, so this is the
  // largest amplitude the girth can carry. Authoring the meander in radii alone
  // let a short stout bole ask for a corkscrew it cannot physically be.
  const requested = lerpNumber(profile.meander[0], profile.meander[1], identity) *
    trunkRadius
  const wavelengths = Math.max(0.35, Math.PI * 2 * profile.meanderTurns)
  const limit = boleHeight > 0
    ? Math.max(
        trunkRadius * 0.05,
        (boleHeight * boleHeight * 0.34) / (trunkRadius * wavelengths * wavelengths),
      )
    : requested
  const meanderAmount = Math.min(requested, limit)
  const envelope = smoothstep(0, 0.3, u) * (1 - u * 0.2)
  const phase = second * Math.PI * 2
  const wave = u * Math.PI * profile.meanderTurns * 2 + phase
  return {
    radiusMultiplier: column + swelling + foot,
    offset: Math.sin(wave) * meanderAmount * envelope,
    crossOffset: Math.sin(wave * 1.41 + 1.1) * meanderAmount * envelope * 0.5,
  }
}
