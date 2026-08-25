import type { TreeSpecies } from '../../speciesCatalog'

export interface ExplicitScaffoldProfile {
  leader: boolean
  attachment: readonly [number, number]
  primaryRise: readonly [number, number]
  primaryLength: readonly [number, number]
  primaryRadius: readonly [number, number]
  primarySag: number
  primaryCrook: number
  secondaryCount: number
  /** Span of the parent scaffold allowed to bear secondary branches. */
  secondarySpan?: readonly [number, number]
  secondaryRise: readonly [number, number]
  secondaryLength: readonly [number, number]
  secondarySag: number
  secondaryCrook: number
  terminalLeaderLength: number
  terminalLeaderRise: number
  primaryFoliageStations: number
  foliageSpan: readonly [number, number]
  foliageStations: number
  organRadius: number
  organDepth: number
  /** Volumetric offset of spray centres, relative to organ radius. */
  foliageJitterScale?: number
  /** Extra size for the guaranteed terminal spray on each woody axis. */
  terminalOrganScale?: number
  /** Art-direction controls for species whose major limbs are deliberately unequal. */
  dominantScaffolds?: number
  subordinateLengthScale?: number
  subordinateRadiusScale?: number
  azimuthJitter?: number
  primaryMidSag?: number
  /** Blend lateral scaffold bases toward the bole tangent before turning out. */
  primaryBaseBlend?: number
  /** How far the bole-tangent departure persists, relative to scaffold length. */
  primaryStartTangentStrength?: number
  secondaryMidSag?: number
  /** Scale of the secondary crown borne by a short bole-closing continuation. */
  continuationCrownScale?: number
  /** Fine woody hierarchy carried by each secondary, before leaf-bearing sprays. */
  tertiaryCount?: number
  tertiaryRise?: readonly [number, number]
  tertiaryLength?: readonly [number, number]
  tertiarySag?: number
  tertiaryCrook?: number
  tertiaryFoliageStations?: number
  /** Authored major-limb grammar for species whose identity depends on asymmetry. */
  scaffolds?: readonly {
    attachment: number
    azimuth: number
    rise: number
    lengthScale: number
    sag: number
    crook?: number
    /** Attach this limb to an earlier authored scaffold instead of the bole. */
    parentScaffold?: number
    /** Position along the parent scaffold used by a nested crown fork. */
    parentAttachment?: number
    /** This authored axis inherits the bole's terminal ring as a true fork leader. */
    continuation?: boolean
  }[]
}

const CEIBA: ExplicitScaffoldProfile = {
  leader: true,
  attachment: [0.78, 0.97],
  primaryRise: [0.12, 0.5],
  primaryLength: [0.68, 1.05],
  primaryRadius: [0.15, 0.24],
  primarySag: 0.06,
  primaryCrook: 0.045,
  secondaryCount: 6,
  secondaryRise: [0.1, 0.62],
  secondaryLength: [0.24, 0.46],
  secondarySag: 0.08,
  secondaryCrook: 0.06,
  terminalLeaderLength: 0,
  terminalLeaderRise: 0,
  primaryFoliageStations: 6,
  foliageSpan: [0.72, 1],
  foliageStations: 16,
  organRadius: 0.92,
  organDepth: 1.02,
}

const PROFILES = {
  'kapok-ceiba': CEIBA,
  baobab: {
    leader: true,
    attachment: [0.58, 0.98],
    primaryRise: [0.2, 0.68],
    primaryLength: [0.56, 0.86],
    primaryRadius: [0.28, 0.4],
    primarySag: 0.055,
    primaryMidSag: 0.045,
    primaryCrook: 0.115,
    primaryBaseBlend: 0.32,
    primaryStartTangentStrength: 0.2,
    secondaryCount: 5,
    secondarySpan: [0.62, 0.9],
    secondaryRise: [0.08, 0.72],
    secondaryLength: [0.22, 0.42],
    secondarySag: 0.065,
    secondaryMidSag: 0.035,
    secondaryCrook: 0.12,
    terminalLeaderLength: 0,
    terminalLeaderRise: 0,
    primaryFoliageStations: 1,
    foliageSpan: [0.72, 1],
    foliageStations: 8,
    organRadius: 0.74,
    organDepth: 0.8,
    foliageJitterScale: 0.46,
    terminalOrganScale: 1.32,
    continuationCrownScale: 0.72,
    tertiaryCount: 3,
    tertiaryRise: [0.04, 0.72],
    tertiaryLength: [0.12, 0.25],
    tertiarySag: 0.05,
    tertiaryCrook: 0.15,
    tertiaryFoliageStations: 8,
    azimuthJitter: 0.22,
    scaffolds: [
      {
        attachment: 1,
        azimuth: 0.1,
        rise: 0.62,
        lengthScale: 0.38,
        sag: 0.025,
        crook: 0.12,
        continuation: true,
      },
      {
        attachment: 0.56,
        azimuth: 0.2,
        rise: 0.34,
        lengthScale: 1.08,
        sag: 0.11,
        crook: 0.17,
      },
      {
        attachment: 0.64,
        azimuth: 2.25,
        rise: 0.38,
        lengthScale: 0.94,
        sag: 0.075,
        crook: 0.14,
      },
      {
        attachment: 0.73,
        azimuth: 4.28,
        rise: 0.3,
        lengthScale: 1.12,
        sag: 0.13,
        crook: 0.18,
      },
      {
        attachment: 0.82,
        azimuth: 1.32,
        rise: 0.56,
        lengthScale: 0.78,
        sag: 0.045,
        crook: 0.13,
      },
      {
        attachment: 0.9,
        azimuth: 3.38,
        rise: 0.42,
        lengthScale: 0.84,
        sag: 0.06,
        crook: 0.15,
      },
    ],
  },
  'umbrella-acacia': {
    leader: false,
    attachment: [0.62, 0.86],
    primaryRise: [0.12, 0.28],
    primaryLength: [0.78, 1.18],
    primaryRadius: [0.28, 0.42],
    primarySag: 0.02,
    primaryCrook: 0.08,
    secondaryCount: 5,
    secondaryRise: [-0.04, 0.08],
    secondaryLength: [0.34, 0.6],
    secondarySag: 0.03,
    secondaryCrook: 0.075,
    terminalLeaderLength: 0.22,
    terminalLeaderRise: 0.22,
    primaryFoliageStations: 12,
    foliageSpan: [0.2, 1],
    foliageStations: 44,
    organRadius: 0.68,
    organDepth: 0.74,
    dominantScaffolds: 6,
    subordinateLengthScale: 0.78,
    azimuthJitter: 0.46,
    primaryMidSag: 0.04,
    secondaryMidSag: 0.025,
  },
  'live-oak': {
    leader: false,
    attachment: [0.58, 0.94],
    primaryRise: [0.26, 0.68],
    primaryLength: [0.64, 1.02],
    primaryRadius: [0.24, 0.35],
    primarySag: 0.08,
    primaryCrook: 0.12,
    secondaryCount: 7,
    secondaryRise: [0.06, 0.56],
    secondaryLength: [0.24, 0.48],
    secondarySag: 0.08,
    secondaryCrook: 0.14,
    terminalLeaderLength: 0.24,
    terminalLeaderRise: 0.48,
    primaryFoliageStations: 22,
    foliageSpan: [0.22, 1],
    foliageStations: 42,
    organRadius: 0.92,
    organDepth: 0.96,
    foliageJitterScale: 0.52,
    terminalOrganScale: 1.9,
    dominantScaffolds: 3,
    subordinateLengthScale: 0.74,
    subordinateRadiusScale: 0.48,
    azimuthJitter: 0.9,
    primaryMidSag: 0.09,
    primaryBaseBlend: 0.28,
    primaryStartTangentStrength: 0.24,
    secondaryMidSag: 0.055,
    continuationCrownScale: 0.28,
    tertiaryCount: 3,
    tertiaryRise: [0.18, 0.82],
    tertiaryLength: [0.12, 0.26],
    tertiarySag: 0.045,
    tertiaryCrook: 0.15,
    tertiaryFoliageStations: 10,
    scaffolds: [
      {
        attachment: 0.48,
        azimuth: 0.05,
        rise: 0.2,
        lengthScale: 0.96,
        sag: 0.14,
        crook: 0.2,
      },
      {
        attachment: 0.57,
        azimuth: 0.92,
        rise: 0.34,
        lengthScale: 0.88,
        sag: 0.1,
        crook: 0.17,
      },
      {
        attachment: 0.7,
        azimuth: 1.82,
        rise: 0.26,
        lengthScale: 0.6,
        sag: 0.08,
        crook: 0.14,
      },
      {
        attachment: 0.53,
        azimuth: 2.72,
        rise: 0.24,
        lengthScale: 1,
        sag: 0.13,
        crook: 0.22,
        parentScaffold: 1,
        parentAttachment: 0.52,
      },
      {
        attachment: 0.64,
        azimuth: 3.56,
        rise: 0.5,
        lengthScale: 0.82,
        sag: 0.07,
        crook: 0.16,
        parentScaffold: 2,
        parentAttachment: 0.48,
      },
      {
        attachment: 0.59,
        azimuth: 4.58,
        rise: 0.3,
        lengthScale: 0.9,
        sag: 0.11,
        crook: 0.19,
        parentScaffold: 0,
        parentAttachment: 0.58,
      },
      {
        attachment: 1,
        azimuth: 5.34,
        rise: 0.32,
        lengthScale: 0.16,
        sag: 0.05,
        crook: 0.12,
        continuation: true,
      },
    ],
  },
} as const satisfies Partial<Record<TreeSpecies, ExplicitScaffoldProfile>>

export function explicitScaffoldProfile(species: TreeSpecies): ExplicitScaffoldProfile {
  return PROFILES[species as keyof typeof PROFILES] ?? CEIBA
}
