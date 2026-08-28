import type { TreeOrganModel } from '../../speciesCatalog'
import type { TreeSpecies } from '../../speciesCatalog'

export interface WhorledProfile {
  tierOffset: number
  tierRange: readonly [number, number]
  crownBase: number
  crownTop: number
  tierJitter: number
  tierRadiusFloor: number
  tierRadiusExponent: number
  branches: readonly [number, number]
  branchLift: readonly [number, number]
  sag: readonly [number, number]
  stationCount: number
  organRadius: readonly [number, number]
  organDepth: number
  hangingCount: number
  hangingLength: readonly [number, number]
  hangingStations: number
  organModel: TreeOrganModel
}

const SPRUCE: WhorledProfile = {
  tierOffset: 3,
  tierRange: [8, 16],
  crownBase: 0.1,
  crownTop: 0.97,
  tierJitter: 0.004,
  tierRadiusFloor: 0.55,
  tierRadiusExponent: 0.72,
  branches: [8, 6],
  branchLift: [0.08, 0.06],
  sag: [0.32, 0.18],
  // Fourteen stations along a branch that now starts carrying them near the
  // bole. A closed spruce tier is a continuous shelf of foliage, and ten
  // stations over the outer two thirds could not make one.
  stationCount: 14,
  organRadius: [0.64, 0.78],
  organDepth: 0.9,
  hangingCount: 2,
  hangingLength: [0.14, 0.24],
  hangingStations: 3,
  organModel: 'needle-spray',
}

const PROFILES = {
  'norway-spruce': SPRUCE,
  'coast-redwood': {
    tierOffset: 10,
    tierRange: [17, 24],
    crownBase: 0.28,
    crownTop: 0.985,
    tierJitter: 0.008,
    tierRadiusFloor: 0.8,
    tierRadiusExponent: 0.88,
    branches: [5, 4],
    branchLift: [0.12, 0.2],
    sag: [0.12, 0.04],
    stationCount: 32,
    organRadius: [1.12, 1.52],
    organDepth: 1.55,
    hangingCount: 1,
    hangingLength: [0.1, 0.17],
    hangingStations: 2,
    organModel: 'scale-foliage',
  },
  'monkey-puzzle': {
    tierOffset: 1,
    tierRange: [7, 12],
    crownBase: 0.34,
    crownTop: 0.96,
    tierJitter: 0.003,
    tierRadiusFloor: 0.5,
    tierRadiusExponent: 0.52,
    branches: [6, 5],
    branchLift: [0.18, 0.38],
    sag: [0.03, 0],
    stationCount: 8,
    organRadius: [0.72, 0.9],
    organDepth: 1.05,
    hangingCount: 0,
    hangingLength: [0.08, 0.1],
    hangingStations: 0,
    organModel: 'scale-foliage',
  },
  'giant-sequoia': {
    tierOffset: 8,
    tierRange: [14, 21],
    crownBase: 0.2,
    crownTop: 0.98,
    tierJitter: 0.012,
    tierRadiusFloor: 0.72,
    tierRadiusExponent: 1.08,
    branches: [6, 5],
    branchLift: [0.12, 0.3],
    sag: [0.12, 0.03],
    stationCount: 30,
    organRadius: [1.5, 2.1],
    organDepth: 1.8,
    hangingCount: 1,
    hangingLength: [0.08, 0.14],
    hangingStations: 2,
    organModel: 'scale-foliage',
  },
  'norfolk-island-pine': {
    tierOffset: 6,
    tierRange: [12, 18],
    crownBase: 0.18,
    crownTop: 0.98,
    tierJitter: 0.002,
    tierRadiusFloor: 0.45,
    tierRadiusExponent: 0.86,
    branches: [6, 5],
    branchLift: [0.08, 0.22],
    sag: [0.04, 0],
    stationCount: 14,
    organRadius: [0.7, 0.94],
    organDepth: 1.08,
    hangingCount: 0,
    hangingLength: [0.08, 0.1],
    hangingStations: 0,
    organModel: 'scale-foliage',
  },
} as const satisfies Partial<Record<TreeSpecies, WhorledProfile>>

export function whorledProfile(species: TreeSpecies): WhorledProfile {
  return PROFILES[species as keyof typeof PROFILES] ?? SPRUCE
}
