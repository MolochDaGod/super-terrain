import {
  add,
  clamp,
  lerpNumber,
  multiply,
  normalize,
  TreeRandom,
  vec3,
} from '../math'
import type { SemanticTreePart, TreeParameters, TreeVec3 } from '../types'
import {
  axisDirection,
  axisDirectionAt,
  sampledAxis,
  sampleAxisPosition,
} from './axis'
import { BAOBAB_CROWN_PROFILE as PROFILE } from './profiles/baobabCrownProfile'
import { growTwigMass, orthogonalAround } from './twigMass'
import type {
  GrowthAxisDraft,
  GrowthAxisSample,
  GrowthRegimeResult,
} from './types'

interface CrownAxis {
  draft: GrowthAxisDraft
  length: number
  /** Relative strength; drives length, radius and how much wood survives. */
  vigor: number
}

/**
 * Builds a baobab crown as the continuation of its massive storage bole.
 *
 * Three properties carry the species and none of them survive a generic radial
 * scaffold. The bole divides into a *few unequal* limbs almost as thick as
 * itself, over a band of height rather than at one hub. Those limbs climb
 * before they spread, so the crown has volume instead of being a flat starburst.
 * And every order ends in a dense fan of short crooked shoots, which is the
 * feature the tree is named for and the only way the leaf masses end up in
 * clumps rather than strung along bare poles.
 */
export function growBaobabCrown(
  parameters: TreeParameters,
  trunk: SemanticTreePart,
  random: TreeRandom,
): GrowthRegimeResult {
  const axes: GrowthAxisDraft[] = []
  const organs: GrowthRegimeResult['organs'] = []
  const trunkTip = trunk.spine.at(-1)!
  const trunkDirection = axisDirection(trunk.spine)
  const divisionCount = random.integer(...PROFILE.divisionCount)
  const phase = random.range(0, Math.PI * 2)
  // The crown's own axis. Outward bias is measured from here rather than from
  // the world origin so a leaning bole does not push every limb to one side.
  const crownOrigin = trunkTip.position

  const outwardFrom = (point: TreeVec3, fallback: TreeVec3): TreeVec3 => normalize(
    vec3(point.x - crownOrigin.x, 0, point.z - crownOrigin.z),
    fallback,
  )

  const ramify = (
    parent: CrownAxis,
    depth: number,
    path: string,
    pathRandom: TreeRandom,
  ) => {
    const parentTip = parent.draft.samples.at(-1)!
    const parentDirection = axisDirection(parent.draft.samples)
    // A weak axis stops ramifying early and puts its shoots out where it is.
    // Without this every path runs to the same order and every leaf mass ends
    // up on the crown's outer shell, leaving the interior — and the whole space
    // above the fork — as bare wood.
    const exhausted = depth >= 2 &&
      pathRandom.unit() < (1 - parent.vigor) * PROFILE.exhaustion
    if (depth >= PROFILE.ramificationDepth || exhausted) {
      const fan = growTwigMass(
        parent.draft,
        outwardFrom(parentTip.position, parentDirection),
        PROFILE.twigs,
        pathRandom,
      )
      axes.push(...fan.axes)
      organs.push(...fan.organs)
      return
    }

    // Each order gives up a share of its climb. A baobab limb leaves the bole
    // steeply, is already leaning out one order later, and is running level by
    // the time it reaches the crown surface.
    const levelling = pathRandom.range(...PROFILE.levelling)
    const decay = pathRandom.range(...PROFILE.lengthDecay)

    const bearingFor = (
      source: TreeVec3,
      sourceDirection: TreeVec3,
      opening: number,
      spin: number,
      outwardPull: number,
    ): TreeVec3 => {
      const side = orthogonalAround(sourceDirection, spin)
      const outward = outwardFrom(source, side)
      const levelled = normalize(vec3(
        sourceDirection.x,
        sourceDirection.y * (1 - levelling),
        sourceDirection.z,
      ), sourceDirection)
      return normalize(add(
        multiply(levelled, Math.cos(opening)),
        add(
          multiply(side, Math.sin(opening)),
          multiply(outward, outwardPull),
        ),
      ))
    }

    const continuationOpening = pathRandom.range(...PROFILE.continuationOpening)
    const continuationLength = parent.length * decay * pathRandom.range(0.94, 1.1)
    const continuationRadius = parentTip.radius *
      pathRandom.range(...PROFILE.daughterRadius)
    const continuation: GrowthAxisDraft = {
      id: `baobab-${path}-c`,
      parentId: parent.draft.id,
      attachment: 1,
      branchOrder: parent.draft.branchOrder + 1,
      continuation: true,
      samples: sampledAxis(
        parentTip.position,
        bearingFor(
          parentTip.position,
          parentDirection,
          continuationOpening,
          pathRandom.range(0, Math.PI * 2),
          pathRandom.range(0.12, 0.34),
        ),
        continuationLength,
        continuationRadius,
        Math.max(PROFILE.terminalRadius, continuationRadius * 0.5),
        pathRandom,
        {
          samples: 7,
          startTangent: parentDirection,
          startTangentStrength: 0.42,
          sag: 0.02 + depth * 0.016,
          midSag: 0.024,
          crook: 0.05 + depth * 0.03,
        },
      ),
    }
    axes.push(continuation)
    ramify(
      {
        draft: continuation,
        length: continuationLength,
        vigor: parent.vigor * pathRandom.range(0.88, 1),
      },
      depth + 1,
      `${path}c`,
      pathRandom,
    )

    // Laterals are staggered along the carrier rather than emitted as equal
    // twins from every tip. This is the difference between a lived-in crown
    // with changing leaders and a child's repeated Y-shaped antler.
    const lateralCount = depth <= 1
      ? pathRandom.unit() < 0.76 ? 2 : 1
      : pathRandom.unit() < 0.42 ? 2 : 1
    for (let lateral = 0; lateral < lateralCount; lateral += 1) {
      if (
        depth > 0 &&
        pathRandom.unit() < PROFILE.lossProbability * (0.6 + depth * 0.4)
      ) continue
      const attachment = lateralCount === 2
        ? pathRandom.range(lateral === 0 ? 0.42 : 0.66, lateral === 0 ? 0.64 : 0.9)
        : pathRandom.range(0.5, 0.88)
      const source = sampleAxisPosition(parent.draft.samples, attachment)
      const sourceRadius = radiusAt(parent.draft.samples, attachment)
      const sourceDirection = axisDirectionAt(parent.draft.samples, attachment)
      const lateralRadius = sourceRadius * pathRandom.range(...PROFILE.lateralRadius)
      const lateralLength = parent.length * decay * pathRandom.range(0.66, 0.92)
      const lateralId = `baobab-${path}-l${lateral + 1}`
      const draft: GrowthAxisDraft = {
        id: lateralId,
        parentId: parent.draft.id,
        attachment,
        branchOrder: parent.draft.branchOrder + 1,
        continuation: false,
        samples: sampledAxis(
          source,
          bearingFor(
            source,
            sourceDirection,
            pathRandom.range(...PROFILE.lateralOpening),
            pathRandom.range(0, Math.PI * 2),
            pathRandom.range(0.3, 0.62),
          ),
          lateralLength,
          lateralRadius,
          Math.max(PROFILE.terminalRadius, lateralRadius * 0.44),
          pathRandom,
          {
            samples: 6,
            startTangent: sourceDirection,
            startTangentStrength: 0.24,
            sag: 0.026 + depth * 0.018,
            midSag: 0.028,
            crook: 0.06 + depth * 0.032,
          },
        ),
      }
      axes.push(draft)
      ramify(
        {
          draft,
          length: lateralLength,
          vigor: parent.vigor * pathRandom.range(0.7, 0.92),
        },
        depth + 1,
        `${path}l${lateral + 1}`,
        pathRandom,
      )
    }
  }

  // Divisions are ranked before they are grown so the crown has one clear
  // leader, one near-rival and a couple of weaker limbs, which is the unequal
  // hierarchy a real bole resolves into.
  for (let division = 0; division < divisionCount; division += 1) {
    const divisionRandom = new TreeRandom(
      (parameters.seed ^ 0x6a09e667 ^ Math.imul(division + 1, 0x9e3779b1)) >>> 0,
    )
    const rank = divisionCount > 1 ? division / (divisionCount - 1) : 0
    const vigor = lerpNumber(
      PROFILE.divisionVigor[1],
      PROFILE.divisionVigor[0],
      rank,
    ) * divisionRandom.range(0.92, 1.08)
    const continuation = division === 0
    const attachment = continuation
      ? 1
      : clamp(
          lerpNumber(
            PROFILE.divisionAttachment[1],
            PROFILE.divisionAttachment[0],
            rank,
          ) + divisionRandom.range(-0.06, 0.06),
          PROFILE.divisionAttachment[0],
          // Exactly one is left to the continuation, so a lateral division can
          // never claim the terminal ring the bole hands on.
          Math.min(PROFILE.divisionAttachment[1], 0.985),
        )
    const start = sampleAxisPosition(
      trunk.spine.map(toAxisSample),
      attachment,
    )
    const sourceDirection = continuation
      ? trunkDirection
      : axisDirectionAt(trunk.spine.map(toAxisSample), attachment)
    const sourceRadius = radiusAt(trunk.spine.map(toAxisSample), attachment)
    // Azimuths partition the circle unevenly. A golden angle spreads limbs
    // perfectly, which is exactly the regularity that read as a hub.
    const azimuth = phase + (division / divisionCount) * Math.PI * 2 +
      divisionRandom.range(-0.4, 0.4)
    const radial = vec3(Math.cos(azimuth), 0, Math.sin(azimuth))
    const rise = divisionRandom.range(...PROFILE.divisionRise) *
      lerpNumber(0.82, 1.15, vigor)
    const direction = normalize(add(radial, vec3(0, rise, 0)))
    const length = parameters.crownRadius *
      divisionRandom.range(...PROFILE.divisionLength) * vigor
    // Girth follows rank as well as the bole it leaves. Sizing purely from the
    // local bole radius made the lowest division the thickest, which inverts
    // the hierarchy the ranking exists to create.
    const baseRadius = sourceRadius * divisionRandom.range(...PROFILE.divisionRadius) *
      lerpNumber(0.78, 1.14, vigor) * (continuation ? 1.16 : 1)
    const draft: GrowthAxisDraft = {
      id: `baobab-division-${division + 1}`,
      parentId: trunk.id,
      attachment,
      branchOrder: 1,
      continuation,
      // Trunk-scale: the division starts on the bole's centreline and emerges
      // through its surface, so it must not be given a projected collar.
      embedded: true,
      samples: sampledAxis(
        start,
        direction,
        length,
        baseRadius,
        Math.max(0.16, baseRadius * divisionRandom.range(0.4, 0.52)),
        divisionRandom,
        {
          samples: 10,
          // A trunk-scale limb leaves along the bole and turns outward over its
          // own length; a straight ray from the shoulder is the pipe-in-a-vase
          // reading the dedicated regime exists to remove.
          startTangent: sourceDirection,
          startTangentStrength: continuation ? 0.46 : 0.34,
          sag: divisionRandom.range(0.03, 0.075),
          midSag: divisionRandom.range(0.03, 0.07),
          crook: divisionRandom.range(0.05, 0.1),
        },
      ),
    }
    axes.push(draft)
    ramify({ draft, length, vigor }, 0, `d${division + 1}`, divisionRandom)
  }

  return { axes, organs }
}

function toAxisSample(sample: { position: TreeVec3; radius: number }): GrowthAxisSample {
  return { position: sample.position, radius: sample.radius }
}

function radiusAt(samples: readonly GrowthAxisSample[], t: number): number {
  if (samples.length === 1) return samples[0]!.radius
  const scaled = clamp(t, 0, 1) * (samples.length - 1)
  const left = Math.floor(scaled)
  const right = Math.min(samples.length - 1, left + 1)
  const amount = scaled - left
  return samples[left]!.radius + (samples[right]!.radius - samples[left]!.radius) * amount
}
