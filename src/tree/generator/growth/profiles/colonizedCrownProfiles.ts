import type { TreeSpecies } from '../../speciesCatalog'

export interface ColonizedCrownProfile {
  boleFraction: number
  crownBaseFraction: number
  broadness: number
  profileExponent: number
  lobeAmplitude: number
  lobeCount: number
  lowestScaffold: number
  scaffoldRise: readonly [number, number]
  scaffoldFollow: number
  upTropism: number
  sag: number
  axialPersistence: number
  wander: number
  shellBias: number
  segmentFraction: number
  attractorCount: number
  meshedTipRadius: number
  cardSize: number
  farClusterSize: number
  cardsPerStation: number
  shadeValue: number
  sunValue: number
}

const BANYAN: ColonizedCrownProfile = {
  boleFraction: 0.38,
  crownBaseFraction: 0.28,
  broadness: 0.38,
  profileExponent: 0.28,
  lobeAmplitude: 0.3,
  lobeCount: 5,
  lowestScaffold: 0.34,
  scaffoldRise: [0.04, 0.48],
  scaffoldFollow: 0.2,
  upTropism: 0.24,
  sag: 0.22,
  axialPersistence: 0.5,
  wander: 0.2,
  shellBias: 0.82,
  segmentFraction: 0.05,
  attractorCount: 4200,
  meshedTipRadius: 0.045,
  cardSize: 0.72,
  farClusterSize: 1.34,
  cardsPerStation: 3,
  shadeValue: 0.56,
  sunValue: 1.08,
}

const PROFILES = {
  banyan: BANYAN,
  mangrove: {
    boleFraction: 0.48,
    crownBaseFraction: 0.34,
    broadness: 0.46,
    profileExponent: 0.4,
    lobeAmplitude: 0.34,
    lobeCount: 6,
    lowestScaffold: 0.26,
    scaffoldRise: [0.18, 0.82],
    scaffoldFollow: 0.3,
    upTropism: 0.32,
    sag: 0.16,
    axialPersistence: 0.56,
    wander: 0.2,
    shellBias: 0.92,
    segmentFraction: 0.055,
    attractorCount: 2400,
    meshedTipRadius: 0.034,
    cardSize: 0.64,
    farClusterSize: 1.08,
    cardsPerStation: 3,
    shadeValue: 0.58,
    sunValue: 1.06,
  },
  'strangler-fig': {
    boleFraction: 0.44,
    crownBaseFraction: 0.32,
    broadness: 0.42,
    profileExponent: 0.34,
    lobeAmplitude: 0.3,
    lobeCount: 5,
    lowestScaffold: 0.32,
    scaffoldRise: [0.08, 0.62],
    scaffoldFollow: 0.24,
    upTropism: 0.28,
    sag: 0.18,
    axialPersistence: 0.52,
    wander: 0.24,
    shellBias: 0.86,
    segmentFraction: 0.05,
    attractorCount: 3400,
    meshedTipRadius: 0.04,
    cardSize: 0.68,
    farClusterSize: 1.24,
    cardsPerStation: 3,
    shadeValue: 0.55,
    sunValue: 1.08,
  },
} as const satisfies Partial<Record<TreeSpecies, ColonizedCrownProfile>>

export function colonizedCrownProfile(species: TreeSpecies): ColonizedCrownProfile {
  return PROFILES[species as keyof typeof PROFILES] ?? BANYAN
}
