import { clamp, lerpNumber } from './math'
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
   * Bigger is cheaper. A crown closed with a few large cards costs a fraction
   * of the fill and the draw calls of one closed with many small ones, and at
   * canopy densities the difference is not subtle — so the card is sized as
   * large as the leaf art will carry before individual sprays start reading as
   * individual sprays.
   */
  cardSize: number
  /** Cards placed per foliage station. */
  cardsPerStation: number
  /** Instance-tint multiplier on the atlas albedo, deep in the crown. */
  shadeValue: number
  /** The same multiplier on the sunlit crown surface. */
  sunValue: number
}

export function speciesArchitecture(parameters: TreeParameters): SpeciesArchitecture {
  const age = clamp(parameters.age, 0, 1)
  if (parameters.species === 'windswept-pine') return pine(parameters, age)
  return oak(parameters, age, parameters.species === 'ancient-oak')
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
    scaffoldCount: ancient ? 5 + (parameters.seed % 3) : 4 + (parameters.seed % 2),
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
    meshedTipRadius: 0.026,
    // A card has to be big enough that a few thousand of them close the crown.
    // Undersized cards leave the branch structure showing through, which is
    // what makes a canopy read as a bare winter tree with leaves stuck on.
    cardSize: 1.34,
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
    scaffoldCount: 7,
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
    cardSize: 1.05,
    cardsPerStation: 3,
    shadeValue: 0.52,
    sunValue: 1.02,
  }
}
