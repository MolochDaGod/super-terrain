import { clamp, lerpNumber } from './math'
import { colonizedCrownProfile } from './growth/profiles/colonizedCrownProfiles'
import { openCrownProfile } from './growth/profiles/openCrownProfiles'
import type { TreeParameters } from './types'

/**
 * What a species *is*, expressed as the shape of its crown and the way growth
 * fills it — not as a count of branches.
 *
 * Every field here feeds either the crown envelope or the colonisation step, so
 * adding a species means describing its habit once rather than writing another
 * bespoke scaffold routine. Age interpolates within a species: the same oak
 * description carries a young field oak's oval, apically-dominant crown and a
 * veteran's broad flat mass with heavy low limbs.
 */
export interface SpeciesArchitecture {
  /** Fraction of total height occupied by the clear bole. */
  boleFraction: number
  /** Crown base as a fraction of total height; may sit below the bole top. */
  crownBaseFraction: number
  /** Widest band of the crown, 0 at its base and 1 at its top. */
  broadness: number
  /** Low values square off the profile; high values round it toward a cone. */
  profileExponent: number
  /** Depth of the notches in the crown boundary. */
  lobeAmplitude: number
  lobeCount: number
  /** Scaffold limbs leaving the bole. */
  scaffoldCount: number
  /** Where on the bole the lowest scaffold departs. */
  lowestScaffold: number
  /** Initial rise of a scaffold: near 0 is a horizontal veteran limb. */
  scaffoldRise: [number, number]
  /** How much a scaffold's first segments still follow the bole. */
  scaffoldFollow: number
  upTropism: number
  sag: number
  axialPersistence: number
  wander: number
  shellBias: number
  /** Metres per growth segment, relative to crown radius. */
  segmentFraction: number
  /** Attractor cloud size, which sets ramification density. */
  attractorCount: number
  /** Wood thinner than this becomes foliage cards instead of swept geometry. */
  meshedTipRadius: number
  /**
   * Leaf card half-size in metres, before per-instance jitter.
   *
   * Smaller cards preserve branchlet-scale parallax and stop a whole metre of
   * foliage from lighting as one sheet. Density is budgeted separately, so an
   * author can spend more instances on a closed hero crown without making each
   * spray implausibly large.
   */
  cardSize: number
  /** Far-LOD blob half-size; preserves crown mass after hero cards shrink. */
  farClusterSize: number
  /** Cards placed per foliage station. */
  cardsPerStation: number
  /** Instance-tint multiplier on the atlas albedo, deep in the crown. */
  shadeValue: number
  /** The same multiplier on the sunlit crown surface. */
  sunValue: number
}

export function speciesArchitecture(parameters: TreeParameters): SpeciesArchitecture {
  const age = clamp(parameters.age, 0, 1)
  switch (parameters.species) {
    case 'windswept-pine':
      return pine(parameters, age)
    case 'kapok-ceiba':
      return regimeArchitecture(parameters, {
        boleFraction: 0.8,
        crownBaseFraction: 0.72,
        cardSize: 0.9,
        farClusterSize: 1.5,
        cardsPerStation: 3,
      })
    case 'baobab':
      return regimeArchitecture(parameters, {
        // Two fifths bole, three fifths crown. The bole is still the heaviest
        // thing in the silhouette because it is enormously wide, not because it
        // occupies most of the tree's height.
        boleFraction: 0.4,
        crownBaseFraction: 0.36,
        cardSize: 0.54,
        farClusterSize: 1.32,
        cardsPerStation: 5,
      })
    case 'coconut-palm':
      return regimeArchitecture(parameters, {
        boleFraction: 0.9,
        crownBaseFraction: 0.86,
        cardSize: 0.7,
        farClusterSize: 1.8,
        cardsPerStation: 1,
      })
    case 'dragon-blood':
      return regimeArchitecture(parameters, {
        // A dragon’s blood divides just above a short thick bole; a third of
        // its height as clear stem is a palm silhouette, not a Dracaena.
        boleFraction: 0.18,
        crownBaseFraction: 0.22,
        cardSize: 0.7,
        farClusterSize: 1.15,
        cardsPerStation: 7,
      })
    case 'norway-spruce':
      return regimeArchitecture(parameters, {
        boleFraction: 0.98,
        crownBaseFraction: 0.28,
        cardSize: 0.62,
        farClusterSize: 1.05,
        cardsPerStation: 4,
      })
    case 'coast-redwood':
      return regimeArchitecture(parameters, {
        boleFraction: 0.995,
        crownBaseFraction: 0.24,
        cardSize: 0.72,
        farClusterSize: 1.3,
        cardsPerStation: 4,
      })
    case 'monkey-puzzle':
      return regimeArchitecture(parameters, {
        boleFraction: 0.99,
        crownBaseFraction: 0.4,
        cardSize: 0.58,
        farClusterSize: 1.05,
        cardsPerStation: 4,
      })
    case 'date-palm':
      return regimeArchitecture(parameters, {
        boleFraction: 0.9,
        crownBaseFraction: 0.86,
        cardSize: 0.62,
        farClusterSize: 1.65,
        cardsPerStation: 1,
      })
    case 'tree-fern':
      return regimeArchitecture(parameters, {
        boleFraction: 0.86,
        crownBaseFraction: 0.8,
        cardSize: 0.58,
        farClusterSize: 1.5,
        cardsPerStation: 1,
      })
    case 'quiver-tree':
      return regimeArchitecture(parameters, {
        // The candelabrum starts low. A long clear pole under a small tuft was
        // the rejected reading.
        boleFraction: 0.26,
        crownBaseFraction: 0.3,
        cardSize: 0.82,
        farClusterSize: 1.2,
        cardsPerStation: 6,
      })
    case 'doum-palm':
      return regimeArchitecture(parameters, {
        // The first genuine dichotomy is low on the stipe, which is what gives
        // the doum two substantial trunks rather than one pole with a fork on top.
        boleFraction: 0.24,
        crownBaseFraction: 0.28,
        cardSize: 0.68,
        farClusterSize: 1.5,
        cardsPerStation: 1,
      })
    case 'joshua-tree':
      return regimeArchitecture(parameters, {
        // Yucca brevifolia branches low and often; a tall clear mast is what a
        // damage-triggered architecture is supposed to prevent.
        boleFraction: 0.24,
        crownBaseFraction: 0.28,
        cardSize: 0.76,
        farClusterSize: 1.1,
        cardsPerStation: 7,
      })
    case 'screw-pine-pandanus':
      return regimeArchitecture(parameters, {
        boleFraction: 0.74,
        crownBaseFraction: 0.7,
        cardSize: 0.7,
        farClusterSize: 1.45,
        cardsPerStation: 1,
      })
    case 'bristlecone-pine':
      return bristlecone(parameters)
    case 'banyan':
    case 'mangrove':
    case 'strangler-fig':
      return {
        ...colonizedCrownProfile(parameters.species),
        scaffoldRise: [...colonizedCrownProfile(parameters.species).scaffoldRise],
        scaffoldCount: parameters.branchCount,
      }
    case 'umbrella-acacia':
    case 'rainbow-eucalyptus':
    case 'gum-eucalyptus':
    case 'live-oak':
    case 'european-beech':
    case 'silver-birch':
    case 'cedar-of-lebanon':
    case 'japanese-black-pine': {
      const profile = openCrownProfile(parameters.species)!
      return {
        ...profile,
        scaffoldRise: [...profile.scaffoldRise],
        scaffoldCount: parameters.branchCount,
      }
    }
    case 'giant-sequoia':
      return regimeArchitecture(parameters, {
        boleFraction: 0.995,
        crownBaseFraction: 0.3,
        cardSize: 0.8,
        farClusterSize: 1.42,
        cardsPerStation: 4,
      })
    case 'norfolk-island-pine':
      return regimeArchitecture(parameters, {
        boleFraction: 0.995,
        crownBaseFraction: 0.2,
        cardSize: 0.62,
        farClusterSize: 1.1,
        cardsPerStation: 4,
      })
    case 'ancient-oak':
    case 'field-oak':
      return oak(parameters, age, parameters.species === 'ancient-oak')
  }
}

function regimeArchitecture(
  parameters: TreeParameters,
  values: Pick<
    SpeciesArchitecture,
    | 'boleFraction'
    | 'crownBaseFraction'
    | 'cardSize'
    | 'farClusterSize'
    | 'cardsPerStation'
  >,
): SpeciesArchitecture {
  return {
    ...values,
    broadness: 0.5,
    profileExponent: 0.5,
    lobeAmplitude: 0.16,
    lobeCount: 5,
    scaffoldCount: parameters.branchCount,
    lowestScaffold: 0.5,
    scaffoldRise: [0.1, 0.7],
    scaffoldFollow: 0.4,
    upTropism: 0.24,
    sag: 0.14,
    axialPersistence: 0.64,
    wander: 0.08,
    shellBias: 1,
    segmentFraction: 0.055,
    attractorCount: 1800,
    meshedTipRadius: 0.022,
    shadeValue: 0.62,
    sunValue: 1.08,
  }
}

/**
 * Quercus. A young oak is a tall oval on a clear bole with a live leader; a
 * veteran has lost the leader entirely, carries three to six near-horizontal
 * limbs off a short massive bole, and spreads wider than it is tall. Both are
 * the same description read at different ages.
 */
function oak(
  parameters: TreeParameters,
  age: number,
  ancient: boolean,
): SpeciesArchitecture {
  // An "ancient-oak" recipe is already old; its age slider varies veteran-ness
  // within that, rather than walking it back to a sapling.
  const veteran = ancient ? clamp(0.55 + age * 0.45, 0, 1) : age * 0.72
  const gnarl = clamp(parameters.gnarl, 0, 1)
  return {
    boleFraction: lerpNumber(0.46, 0.33, veteran),
    // The crown has to start *above* most of the bole or the foliage swallows
    // the trunk, and the trunk is the half of an oak a player stands next to.
    crownBaseFraction: lerpNumber(0.44, 0.3, veteran),
    broadness: lerpNumber(0.52, 0.4, veteran),
    // Flattening the top is most of what separates a veteran oak's mass from a
    // generic tree-shaped blob.
    profileExponent: lerpNumber(0.46, 0.3, veteran),
    lobeAmplitude: lerpNumber(0.2, 0.32, veteran) + gnarl * 0.08,
    lobeCount: ancient ? 4 : 5,
    // The authored major-branch control owns the number of scaffold seeds.
    // Seed variation belongs in their placement and development, not in
    // silently overriding a visible editor parameter.
    scaffoldCount: parameters.branchCount,
    lowestScaffold: lerpNumber(0.72, 0.42, veteran),
    scaffoldRise: ancient ? [0.05, 0.62] : [0.34, 0.95],
    scaffoldFollow: lerpNumber(0.34, 0.2, veteran),
    upTropism: lerpNumber(0.36, 0.27, veteran),
    sag: lerpNumber(0.1, 0.2, veteran),
    axialPersistence: lerpNumber(0.62, 0.5, veteran) + gnarl * 0.04,
    wander: 0.1 + gnarl * 0.16,
    // Well under a full shell bias. Hollowing the crown out completely leaves
    // the interior a bare cage of branches that the camera sees straight into
    // from underneath; a real canopy is thinner inside, not empty.
    shellBias: lerpNumber(0.72, 1.0, veteran),
    segmentFraction: 0.05,
    attractorCount: 4400,
    // Terminal branchlets below a finger's width are represented by layered
    // sprays. Meshing every one of them makes a veteran crown read as a wire
    // cage and spends the hero budget where the cards already provide volume.
    meshedTipRadius: ancient ? 0.042 : 0.03,
    // Branchlet-sized rather than crown-clump-sized. The expanded density range
    // can restore the old projected coverage with more independent sprays.
    cardSize: 0.72,
    farClusterSize: 1.34,
    cardsPerStation: 3,
    shadeValue: 0.58,
    sunValue: 1.12,
  }
}

function pine(parameters: TreeParameters, age: number): SpeciesArchitecture {
  const gnarl = clamp(parameters.gnarl, 0, 1)
  return {
    boleFraction: lerpNumber(0.6, 0.72, age),
    crownBaseFraction: lerpNumber(0.46, 0.58, age),
    broadness: 0.36,
    profileExponent: 0.78,
    lobeAmplitude: 0.2 + gnarl * 0.12,
    lobeCount: 6,
    scaffoldCount: parameters.branchCount,
    lowestScaffold: 0.34,
    scaffoldRise: [-0.14, 0.34],
    scaffoldFollow: 0.42,
    upTropism: 0.14,
    sag: 0.26,
    axialPersistence: 0.7,
    wander: 0.08 + gnarl * 0.14,
    shellBias: 1.9,
    segmentFraction: 0.062,
    attractorCount: 2600,
    meshedTipRadius: 0.024,
    cardSize: 0.6,
    farClusterSize: 1.05,
    cardsPerStation: 3,
    shadeValue: 0.52,
    sunValue: 1.02,
  }
}

function bristlecone(parameters: TreeParameters): SpeciesArchitecture {
  const gnarl = clamp(parameters.gnarl, 0, 1)
  return {
    boleFraction: 0.68,
    crownBaseFraction: 0.5,
    broadness: 0.4,
    profileExponent: 0.5,
    lobeAmplitude: 0.34,
    lobeCount: 4,
    scaffoldCount: parameters.branchCount,
    lowestScaffold: 0.42,
    scaffoldRise: [-0.08, 0.48],
    scaffoldFollow: 0.26,
    upTropism: 0.12,
    sag: 0.18,
    axialPersistence: 0.56,
    wander: 0.18 + gnarl * 0.22,
    shellBias: 1.75,
    segmentFraction: 0.058,
    attractorCount: 1700,
    meshedTipRadius: 0.035,
    cardSize: 0.56,
    farClusterSize: 0.92,
    cardsPerStation: 3,
    shadeValue: 0.5,
    sunValue: 1.02,
  }
}
