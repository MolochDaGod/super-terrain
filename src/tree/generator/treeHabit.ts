import { clamp, lerpNumber, TreeRandom } from './math'
import type { TreeParameters } from './types'

/**
 * The individual life story of one tree, drawn from its seed.
 *
 * Species describes what a tree *is*; habit describes what happened to this
 * one. Two veteran oaks in the same hedgerow are the same species and nothing
 * like each other: one leans away from a neighbour it grew up beside, one lost
 * its top in a storm and rebuilt a crown out of vertical reiterations, one
 * forked at three metres and spent two centuries as twin stems, one stands on a
 * braid of surface roots that leave the soil and dive back in.
 *
 * None of that is reachable by widening a slider. Turning `gnarl` up on a
 * single plan makes one shape wobble harder; it does not make a different tree.
 * These are discrete structural decisions taken once per seed, and they are
 * what make a stand of oaks read as a population rather than as one asset
 * instanced with jitter.
 */

export type BolePlan = 'single' | 'codominant' | 'multistem' | 'fused'
export type AxisForm = 'straight' | 'leaning' | 'sinuous'
export type TrunkDamage = 'intact' | 'snapped'

export type CrownForm =
  /** A complete, roughly even crown. */
  | 'full'
  /** Retrenched: the living crown has withdrawn below a rack of dead spars. */
  | 'stagheaded'
  /** Most of the crown mass thrown to one side. */
  | 'lopsided'
  /** Rebuilt from vertical shoots off old scaffolds after heavy loss. */
  | 'reiterated'

export type RootForm =
  /** Ropes of surface root that break the soil and dive back in repeatedly. */
  | 'braided'
  /** Broad plate buttresses that climb the bole before spreading. */
  | 'buttressed'
  /** Soil has eroded away, leaving the tree standing on arched roots. */
  | 'stilted'
  /** Roots that run mostly under the surface, showing only at the flare. */
  | 'sunken'

export interface LostLimb {
  /** Direction the limb went, in radians around the bole. */
  azimuth: number
  /** How far up the bole it left, as a spine parameter. */
  height: number
  /** Diameter of the wound relative to the bole there. */
  scale: number
  /** Whether new vertical growth answered the loss. */
  reiterated: boolean
}

export interface TreeHabit {
  bolePlan: BolePlan
  axisForm: AxisForm
  trunkDamage: TrunkDamage
  crownForm: CrownForm
  rootForm: RootForm
  /** Radians of lean from vertical, and the direction it leans. */
  lean: number
  leanAzimuth: number
  /** Amplitude and wavelength of the bole's own meander, in bole radii. */
  sinuosity: number
  sinuosityTurns: number
  /** Spiral grain, in radians over the whole bole. */
  twist: number
  /** Depth of the vertical fluting between buttress ribs, 0 to 1. */
  fluting: number
  /** Where a co-dominant bole splits, as a spine parameter. Zero if it does not. */
  forkHeight: number
  /** How evenly a co-dominant fork divides. 0.5 is a true twin. */
  forkBalance: number
  /** Number of trunk-scale axes above the shared basal union. */
  stemCount: number
  /** Turns made by fused stems around their shared load axis. */
  stemTwist: number
  /** Fraction of full height the bole reaches before its break. 1 if intact. */
  snapHeight: number
  lostLimbs: LostLimb[]
  /** Dead spars standing above the living crown. */
  deadSparCount: number
  /** How far the living crown has withdrawn below the tree's full height. */
  retrenchment: number
  /** Direction the crown is thrown, and how hard. */
  crownBias: number
  crownBiasAzimuth: number
  /** How readily crossing members fuse where they touch. */
  graftChance: number
  /** How far surface roots rise clear of the soil, in root radii. */
  rootRelief: number
  /** How many times a surface root breaks the soil along its run. */
  rootSurfacings: number
}

export function deriveTreeHabit(parameters: TreeParameters): TreeHabit {
  // A stream of its own, so changing an unrelated slider does not reshuffle
  // which tree this seed is.
  const random = new TreeRandom((parameters.seed ^ 0x5bf03635) >>> 0 || 1)
  const ancient = parameters.species === 'ancient-oak'
  const pine = parameters.species === 'windswept-pine'
  const age = clamp(parameters.age, 0, 1)
  const gnarl = clamp(parameters.gnarl, 0, 1)
  // Veteran-ness gates the dramatic forms: a young tree has not had time to
  // lose a top or retrench a crown.
  const veteran = ancient ? clamp(0.5 + age * 0.5, 0, 1) : age * 0.7

  // Independent choices compose. A fused plan may still be sinuous and
  // snapped; none of those traits has to consume the slot of another.
  const bolePlan = parameters.bolePlan === 'auto'
    ? pickBolePlan(random, veteran, gnarl, pine)
    : parameters.bolePlan
  const axisForm = parameters.axisForm === 'auto'
    ? pickAxisForm(random, gnarl, pine)
    : parameters.axisForm
  const trunkDamage = parameters.trunkDamage === 'auto'
    ? pickTrunkDamage(random, veteran, pine)
    : parameters.trunkDamage
  const crownForm = parameters.crownForm === 'auto'
    ? pickCrownForm(random, veteran, pine)
    : parameters.crownForm
  const rootForm = parameters.rootForm === 'auto'
    ? pickRootForm(random, veteran, pine)
    : parameters.rootForm

  const leanAzimuth = random.range(0, Math.PI * 2)
  // The slider sets how far this species' lean *can* go; the form decides
  // whether this individual actually took it. A "straight" bole still carries a
  // degree or two, because nothing grown outdoors is plumb.
  const leanLimit = (parameters.lean * Math.PI) / 180
  const lean = axisForm === 'leaning'
    ? leanLimit * random.range(0.62, 1) * (0.7 + gnarl * 0.45)
    : leanLimit * random.range(0, 0.22)

  const snapped = trunkDamage === 'snapped'
  const divided = bolePlan !== 'single'
  const weaveDirection = parameters.twist < 0
    ? -1
    : parameters.twist > 0
      ? 1
      : random.unit() < 0.5 ? -1 : 1

  const lostLimbCount = pine
    ? 0
    : Math.max(0, Math.round(
        parameters.lostLimbs * lerpNumber(0.25, 1, veteran) *
          random.range(0.6, 1.25) +
          (crownForm === 'reiterated' ? 1 : 0),
      ))
  const lostLimbs: LostLimb[] = []
  const woundOffset = random.range(0, Math.PI * 2)
  for (let index = 0; index < lostLimbCount; index += 1) {
    lostLimbs.push({
      // Spread around the bole but never evenly: limb loss is weather and
      // decay, not a pattern.
      azimuth: woundOffset + index * 2.399963229728653 + random.range(-0.6, 0.6),
      height: clamp(random.range(0.3, 0.98), 0.25, 0.99),
      scale: random.range(0.28, 0.62),
      reiterated: crownForm === 'reiterated' || random.unit() < 0.45,
    })
  }

  return {
    bolePlan,
    axisForm,
    trunkDamage,
    crownForm,
    rootForm,
    lean,
    leanAzimuth,
    sinuosity: parameters.sinuosity * (axisForm === 'sinuous'
      ? random.range(0.8, 1.35) * (0.6 + gnarl * 0.6)
      : random.range(0.08, 0.34) * (0.5 + gnarl * 0.8)),
    sinuosityTurns: axisForm === 'sinuous'
      ? random.range(1.3, 2.4)
      : random.range(0.6, 1.4),
    // In turns over the whole bole, and it commits to a handedness: a trunk
    // whose grain wanders back and forth is not spiral grain, it is noise.
    twist: parameters.twist * Math.PI * 2 *
      (random.unit() < 0.5 ? -1 : 1) *
      random.range(0.5, 1) * lerpNumber(0.45, 1.15, veteran),
    fluting: clamp(
      parameters.fluting * lerpNumber(0.45, 1.15, veteran) * random.range(0.7, 1.2) +
        (rootForm === 'buttressed' ? 0.2 : 0),
      0,
      1.2,
    ),
    // These are deliberately low. A division hidden inside the crown is read
    // as two branches on the same generic trunk, not as a different bole plan.
    forkHeight: bolePlan === 'codominant'
      ? random.range(0.16, 0.38)
      : bolePlan === 'multistem'
        ? random.range(0.035, 0.13)
        : bolePlan === 'fused'
          ? random.range(0.025, 0.09)
          : 0,
    forkBalance: divided ? random.range(0.34, 0.5) : 0,
    stemCount: bolePlan === 'multistem'
      ? 3 + Math.floor(random.unit() * 3)
      : bolePlan === 'fused'
        ? 2 + (random.unit() < 0.42 ? 1 : 0)
        : bolePlan === 'codominant'
          ? 2
          : 1,
    stemTwist: bolePlan === 'fused'
      // The same authored twist control drives the actual axes here, not just
      // the grain. Even at zero a fused pair makes most of one slow exchange;
      // the full range reaches exactly six turns over the tree. This stays
      // predictable for authoring rather than hiding strength in seed noise.
      ? (0.9 + Math.abs(parameters.twist) * 0.85) * weaveDirection
      : 0,
    snapHeight: snapped ? random.range(0.45, 0.78) : 1,
    lostLimbs,
    // Bare spars belong to a visibly retrenched crown. Scattering one or two
    // above an otherwise full crown reads as procedural whip geometry rather
    // than as coherent deadwood history.
    deadSparCount: crownForm === 'stagheaded'
      ? 3 + Math.floor(random.unit() * 5)
      : 0,
    retrenchment: crownForm === 'stagheaded' ? random.range(0.14, 0.3) : 0,
    crownBias: crownForm === 'lopsided'
      ? random.range(0.3, 0.52)
      : random.range(0.06, 0.2),
    crownBiasAzimuth: axisForm === 'leaning'
      // A leaning tree throws its crown back over its own base or it falls
      // over, so the two directions are related rather than independent.
      ? leanAzimuth + Math.PI + random.range(-0.7, 0.7)
      : random.range(0, Math.PI * 2),
    graftChance: clamp(lerpNumber(0.08, 0.5, veteran) * (0.6 + gnarl), 0, 0.85),
    rootRelief: parameters.rootRelief * (rootForm === 'stilted'
      ? random.range(1.3, 2.1)
      : rootForm === 'braided'
        ? random.range(0.8, 1.35)
        : rootForm === 'buttressed'
          ? random.range(0.5, 0.9)
          : random.range(0.12, 0.4)),
    rootSurfacings: Math.max(0, Math.round(
      parameters.rootSurfacings * (rootForm === 'braided'
        ? random.range(0.85, 1.5)
        : rootForm === 'stilted'
          ? random.range(0.6, 1.1)
          : rootForm === 'buttressed'
            ? random.range(0.3, 0.7)
            : random.range(0, 0.35)),
    )),
  }
}

function pickBolePlan(
  random: TreeRandom,
  veteran: number,
  gnarl: number,
  pine: boolean,
): BolePlan {
  if (pine) return random.unit() < 0.9 ? 'single' : 'codominant'
  return weighted(random, [
    ['single', 1.15 - veteran * 0.4],
    ['codominant', 0.2 + veteran * 0.55],
    ['multistem', 0.08 + veteran * 0.28],
    ['fused', 0.06 + veteran * gnarl * 0.32],
  ])
}

function pickAxisForm(random: TreeRandom, gnarl: number, pine: boolean): AxisForm {
  if (pine) return random.unit() < 0.7 ? 'leaning' : 'sinuous'
  return weighted(random, [
    ['straight', 0.9 - gnarl * 0.35],
    ['leaning', 0.45 + gnarl * 0.3],
    ['sinuous', 0.35 + gnarl * 0.75],
  ])
}

function pickTrunkDamage(
  random: TreeRandom,
  veteran: number,
  pine: boolean,
): TrunkDamage {
  if (pine) return 'intact'
  return weighted(random, [
    ['intact', 1.25 - veteran * 0.25],
    ['snapped', veteran * 0.55],
  ])
}

function pickCrownForm(random: TreeRandom, veteran: number, pine: boolean): CrownForm {
  if (pine) return random.unit() < 0.6 ? 'lopsided' : 'full'
  return weighted(random, [
    ['full', 1.2 - veteran * 0.6],
    ['lopsided', 0.5],
    ['stagheaded', veteran * 0.85],
    ['reiterated', veteran * 0.6],
  ])
}

function pickRootForm(random: TreeRandom, veteran: number, pine: boolean): RootForm {
  if (pine) return random.unit() < 0.5 ? 'sunken' : 'buttressed'
  return weighted(random, [
    ['braided', 0.6 + veteran * 0.7],
    ['buttressed', 0.55 + veteran * 0.5],
    ['stilted', veteran * 0.5],
    ['sunken', 0.75 - veteran * 0.35],
  ])
}

function weighted<T extends string>(
  random: TreeRandom,
  entries: readonly (readonly [T, number])[],
): T {
  let total = 0
  for (const [, weight] of entries) total += Math.max(0, weight)
  let roll = random.unit() * total
  for (const [value, weight] of entries) {
    roll -= Math.max(0, weight)
    if (roll <= 0) return value
  }
  return entries[0]![0]
}
