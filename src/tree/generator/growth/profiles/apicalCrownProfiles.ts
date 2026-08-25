import type { TreeSpecies } from '../../speciesCatalog'

export interface ApicalCrownProfile {
  minimumOrgans: number
  authoredCountScale: number
  densityCountScale: number
  liftTop: number
  liftDrop: number
  liftJitter: number
  /** Additional downward pitch carried only by the oldest retained leaves. */
  oldSkirtDrop: number
  radius: readonly [number, number]
  depth: readonly [number, number]
  ageOcclusion: number
  /** Radial offset of each leaf base around the apical bud, in trunk radii. */
  attachmentRadius: number
  /** Vertical layering of older leaf bases down the crown bowl, in trunk radii. */
  attachmentDrop: number
  /** Height of the swollen apical bud/crown bowl, in trunk radii. */
  budHeight: number
  /** Maximum crown-bowl girth relative to the trunk's terminal radius. */
  budSwell: number
  /** Swept petiole length as a fraction of the full frond length. */
  petioleLength: readonly [number, number]
  /** Petiole base radius in trunk radii. */
  petioleRadius: readonly [number, number]
  /** Pendant reproductive bunches carried below the live frond bowl. */
  fruitClusters: number
  fruitModel: 'none' | 'date-bunch' | 'coconut-cluster'
  /** Beaded fruit-bearing strands per bunch. */
  fruitStrands: readonly [number, number]
  /** Strand length as a fraction of crown radius. */
  fruitLength: readonly [number, number]
  fruitsPerCluster: readonly [number, number]
  /** Fruit radius in trunk radii. */
  fruitRadius: readonly [number, number]
}

const COCONUT: ApicalCrownProfile = {
  minimumOrgans: 48,
  authoredCountScale: 1.25,
  densityCountScale: 0.75,
  liftTop: 0.78,
  liftDrop: 1.04,
  liftJitter: 0.12,
  oldSkirtDrop: 0.22,
  radius: [0.14, 0.19],
  depth: [0.78, 1.04],
  ageOcclusion: 0.24,
  attachmentRadius: 0.38,
  attachmentDrop: 0.82,
  budHeight: 1.18,
  budSwell: 1.14,
  petioleLength: [0.12, 0.17],
  petioleRadius: [0.075, 0.105],
  fruitClusters: 3,
  fruitModel: 'coconut-cluster',
  fruitStrands: [1, 1],
  fruitLength: [0.05, 0.08],
  fruitsPerCluster: [6, 10],
  fruitRadius: [0.34, 0.42],
}

const PROFILES = {
  'coconut-palm': COCONUT,
  'date-palm': {
    minimumOrgans: 72,
    authoredCountScale: 1.9,
    densityCountScale: 1.1,
    liftTop: 0.9,
    liftDrop: 0.98,
    liftJitter: 0.14,
    oldSkirtDrop: 0.28,
    radius: [0.115, 0.16],
    depth: [0.74, 1.02],
    ageOcclusion: 0.3,
    attachmentRadius: 0.55,
    attachmentDrop: 0.9,
    budHeight: 1.4,
    budSwell: 1.12,
    petioleLength: [0.075, 0.13],
    petioleRadius: [0.065, 0.095],
    // The renderer currently has no separate fleshy-organ material. Beaded
    // woody proxy strands read as hanging wire, so the topology remains
    // available to future fruiting variants but is not enabled for the hero.
    fruitClusters: 5,
    fruitModel: 'date-bunch',
    fruitStrands: [30, 38],
    fruitLength: [0.16, 0.23],
    fruitsPerCluster: [720, 940],
    fruitRadius: [0.036, 0.048],
  },
  'tree-fern': {
    minimumOrgans: 18,
    authoredCountScale: 0.9,
    densityCountScale: 0.55,
    liftTop: 0.48,
    liftDrop: 0.78,
    liftJitter: 0.05,
    oldSkirtDrop: 0.12,
    radius: [0.1, 0.14],
    depth: [0.72, 0.94],
    ageOcclusion: 0.2,
    attachmentRadius: 0.1,
    attachmentDrop: 0.56,
    budHeight: 0.82,
    budSwell: 1.16,
    petioleLength: [0.1, 0.15],
    petioleRadius: [0.055, 0.082],
    fruitClusters: 0,
    fruitModel: 'none',
    fruitStrands: [0, 0],
    fruitLength: [0, 0],
    fruitsPerCluster: [0, 0],
    fruitRadius: [0, 0],
  },
  'screw-pine-pandanus': {
    minimumOrgans: 24,
    authoredCountScale: 1,
    densityCountScale: 0.55,
    liftTop: 0.72,
    liftDrop: 1.12,
    liftJitter: 0.08,
    oldSkirtDrop: 0.16,
    radius: [0.12, 0.17],
    depth: [0.56, 0.78],
    ageOcclusion: 0.28,
    attachmentRadius: 0.18,
    attachmentDrop: 0.68,
    budHeight: 0.9,
    budSwell: 1.2,
    petioleLength: [0.1, 0.16],
    petioleRadius: [0.065, 0.095],
    fruitClusters: 0,
    fruitModel: 'none',
    fruitStrands: [0, 0],
    fruitLength: [0, 0],
    fruitsPerCluster: [0, 0],
    fruitRadius: [0, 0],
  },
} as const satisfies Partial<Record<TreeSpecies, ApicalCrownProfile>>

export function apicalCrownProfile(species: TreeSpecies): ApicalCrownProfile {
  return PROFILES[species as keyof typeof PROFILES] ?? COCONUT
}
