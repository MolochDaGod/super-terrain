import { smoothstep } from '../../math'
import type { TreeSpecies } from '../../speciesCatalog'

export interface PalmTrunkProfile {
  /** Radius of the mature column away from the base and crown. */
  columnRadius: number
  /** Additional lower-column taper and root-mantle swelling. */
  baseSwell: number
  /** Fraction of bole height occupied by the basal swelling. */
  baseSwellHeight: number
  /** Slight thickening where persistent leaf bases pack around the bud. */
  crownSwell: number
  /** Lost-leaf scar spacing in metres. */
  ringSpacing: number
  /** Radial relief of the raised scar rim. */
  ringRelief: number
  /** Width of one scar rim within its growth interval. */
  ringWidth: number
  /** Slow irregularity in scar spacing, preventing lathed perfect rings. */
  ringJitter: number
  /** Broad mid-bole sweep in trunk radii, independent of small sinuosity. */
  sweep: number
  /** Cross-sweep meander, in trunk radii, preventing a single circular arc. */
  sweepWobble: number
  /** Slow mature-column diameter variation around the nominal radius. */
  columnUndulation: number
  /** Irregular persistent leaf-base relief around the upper column. */
  leafBaseRelief: number
  /** Phyllotactic ranks around the upper stipe. */
  leafBaseRanks: number
  /** Fraction of upper leaf bases that survive as projecting boots. */
  leafBaseRetention: number
  /** Sparse old bases retained after most of the column has weathered flush. */
  erodedBootRetention: number
  /** Normalised bole height where projecting boots begin. */
  leafBaseZoneStart: number
}

const COCONUT: PalmTrunkProfile = {
  columnRadius: 0.7,
  baseSwell: 0.68,
  baseSwellHeight: 0.075,
  crownSwell: 0.08,
  ringSpacing: 0.34,
  ringRelief: 0.075,
  ringWidth: 0.19,
  ringJitter: 0.16,
  sweep: 0.56,
  sweepWobble: 0.22,
  columnUndulation: 0.024,
  leafBaseRelief: 0.045,
  leafBaseRanks: 11,
  leafBaseRetention: 0.68,
  erodedBootRetention: 0.02,
  leafBaseZoneStart: 0.025,
}

const PROFILES = {
  'coconut-palm': COCONUT,
  'date-palm': {
    columnRadius: 0.86,
    baseSwell: 0.24,
    baseSwellHeight: 0.085,
    crownSwell: 0.1,
    ringSpacing: 0.27,
    ringRelief: 0.16,
    ringWidth: 0.085,
    ringJitter: 0.22,
    sweep: 2.05,
    sweepWobble: 0.64,
    columnUndulation: 0.065,
    leafBaseRelief: 0.055,
    leafBaseRanks: 10,
    leafBaseRetention: 0.86,
    erodedBootRetention: 0.68,
    leafBaseZoneStart: 0.04,
  },
  'doum-palm': {
    columnRadius: 0.78,
    baseSwell: 0.34,
    baseSwellHeight: 0.09,
    crownSwell: 0.11,
    ringSpacing: 0.3,
    ringRelief: 0.12,
    ringWidth: 0.22,
    ringJitter: 0.2,
    sweep: 0.32,
    sweepWobble: 0.18,
    columnUndulation: 0.032,
    leafBaseRelief: 0.075,
    leafBaseRanks: 9,
    leafBaseRetention: 0.72,
    erodedBootRetention: 0.24,
    leafBaseZoneStart: 0.08,
  },
  'tree-fern': {
    columnRadius: 0.75,
    baseSwell: 0.5,
    baseSwellHeight: 0.18,
    crownSwell: 0.16,
    ringSpacing: 0.18,
    ringRelief: 0.11,
    ringWidth: 0.3,
    ringJitter: 0.28,
    sweep: 0.16,
    sweepWobble: 0.08,
    columnUndulation: 0.055,
    leafBaseRelief: 0.14,
    leafBaseRanks: 13,
    leafBaseRetention: 0.84,
    erodedBootRetention: 0.16,
    leafBaseZoneStart: 0.68,
  },
  'screw-pine-pandanus': {
    columnRadius: 0.72,
    baseSwell: 0.24,
    baseSwellHeight: 0.08,
    crownSwell: 0.15,
    ringSpacing: 0.22,
    ringRelief: 0.085,
    ringWidth: 0.24,
    ringJitter: 0.24,
    sweep: 0.26,
    sweepWobble: 0.14,
    columnUndulation: 0.04,
    leafBaseRelief: 0.11,
    leafBaseRanks: 8,
    leafBaseRetention: 0.78,
    erodedBootRetention: 0.09,
    leafBaseZoneStart: 0.7,
  },
} as const satisfies Partial<Record<TreeSpecies, PalmTrunkProfile>>

export function palmTrunkProfile(species: TreeSpecies): PalmTrunkProfile {
  return PROFILES[species as keyof typeof PROFILES] ?? COCONUT
}

export function palmTrunkStation(
  profile: PalmTrunkProfile,
  t: number,
  height: number,
  seed: number,
  age: number,
): {
  radiusMultiplier: number
  ellipticity: number
  scarPhase: number
} {
  const base = Math.max(0, 1 - t / profile.baseSwellHeight)
  const crown = Math.max(0, (t - 0.82) / 0.18)
  const scarPhase = t * height / profile.ringSpacing +
    Math.sin(t * Math.PI * 5.4 + seed * 0.00017) * profile.ringJitter
  const cell = scarPhase - Math.floor(scarPhase)
  const distance = Math.min(cell, 1 - cell)
  const scar = Math.exp(-Math.pow(distance / profile.ringWidth, 2))
  const ageRelief = profile.ringRelief * (0.42 + age * 0.58)
  const slowDiameter = (
    Math.sin(t * Math.PI * 3.4 + seed * 0.00023) * 0.64 +
    Math.sin(t * Math.PI * 7.1 + seed * 0.000071) * 0.36
  ) * profile.columnUndulation * smoothstep(0, 0.13, t) * smoothstep(1, 0.78, t)
  const radiusMultiplier = profile.columnRadius + slowDiameter +
    base * profile.baseSwell + crown * crown * profile.crownSwell +
    // The mesh compiler adds localised phyllotactic boot lips. Retain only a
    // quiet whole-ring swell here so the column does not become lathed bands.
    scar * ageRelief * 0.16
  const ellipticity = Math.sin(scarPhase * 1.71 + seed * 0.00031) *
    profile.leafBaseRelief * (0.22 + t * 0.78)
  return { radiusMultiplier, ellipticity, scarPhase }
}
