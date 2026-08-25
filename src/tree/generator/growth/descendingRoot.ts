import {
  clamp,
  groundHeightAt,
  lerpNumber,
  smoothstep,
  TreeRandom,
  vec3,
} from '../math'
import type {
  SemanticTreePart,
  TreeEnvironment,
  TreeSpineSample,
  TreeVec3,
} from '../types'

/**
 * The shared path of a root that leaves wood in the air and reaches the ground.
 *
 * Banyan pillars, mangrove stilts and strangler braids are different plants
 * solving the same problem, and they share the properties that the previous
 * straight-tube version had none of. The member is not one diameter: it hangs
 * as a thread for most of its drop and only becomes a pillar once it is
 * anchored and carrying load. It is not straight: it grew unsupported and
 * swings. It does not stop at the soil plane with a flat disc across it; it
 * flares into the ground and continues below grade.
 */
export interface DescendingRootShape {
  samples: number
  /** Radius where the root leaves its carrier. */
  topRadius: number
  /** Radius where it enters the ground. */
  footRadius: number
  /** Fraction of the run that stays a thread before the pillar thickens. */
  thickenFrom: number
  /** Free-hanging lateral wander, in metres. */
  wander: number
  /** Cycles of that wander over the whole run. */
  wanderTurns: number
  /** Outward bow, as a fraction of the horizontal span. */
  arch: number
  /** Extra girth in the last stretch, where the root fuses with the soil. */
  footFlare: number
  /** How far below grade the tip is taken, in foot radii. */
  burial: number
}

/**
 * Builds one descending root from a point in the air to a ground anchor.
 *
 * The anchor's height is resolved against the terrain rather than assumed, so
 * a sloped or uneven site still gets roots that meet it.
 */
export function descendingRoot(
  id: string,
  parentId: string,
  attachment: number,
  source: TreeVec3,
  anchor: TreeVec3,
  shape: DescendingRootShape,
  random: TreeRandom,
  environment: TreeEnvironment,
): SemanticTreePart {
  const ground = groundHeightAt(
    anchor.x,
    anchor.z,
    environment.groundHeight,
    environment.slopeX,
    environment.slopeZ,
  )
  const foot = vec3(anchor.x, ground - shape.footRadius * shape.burial, anchor.z)
  const spanX = foot.x - source.x
  const spanZ = foot.z - source.z
  const span = Math.hypot(spanX, spanZ)
  // A near-vertical root has no horizontal span to bow within, so its swing is
  // measured against its own drop instead. Without this every banyan pillar
  // came out as a perfectly straight pipe.
  const drop = Math.max(0.1, source.y - foot.y)
  const outwardX = span > 1e-4 ? spanX / span : 1
  const outwardZ = span > 1e-4 ? spanZ / span : 0
  const sideX = -outwardZ
  const sideZ = outwardX
  const phase = random.range(0, Math.PI * 2)
  const swing = random.range(0.6, 1.25)

  const samples: TreeSpineSample[] = []
  const count = Math.max(6, shape.samples)
  for (let step = 0; step < count; step += 1) {
    const t = step / (count - 1)
    const envelope = Math.sin(t * Math.PI)
    const wander = Math.sin(t * Math.PI * shape.wanderTurns + phase) *
      shape.wander * swing * envelope
    const crossWander = Math.cos(t * Math.PI * shape.wanderTurns * 0.63 + phase * 1.7) *
      shape.wander * swing * 0.55 * envelope
    const bow = envelope * Math.max(span, drop * 0.35) * shape.arch
    const position = vec3(
      lerpNumber(source.x, foot.x, t) + outwardX * bow + sideX * wander +
        outwardX * crossWander,
      lerpNumber(source.y, foot.y, t),
      lerpNumber(source.z, foot.z, t) + outwardZ * bow + sideZ * wander +
        outwardZ * crossWander,
    )
    // Thread first, pillar later. A linear taper over the whole drop is what
    // made these read as uniform poles pushed through the canopy.
    const thicken = smoothstep(shape.thickenFrom, 1, t)
    const flare = 1 + shape.footFlare * smoothstep(0.86, 1, t)
    const radius = lerpNumber(
      shape.topRadius,
      shape.footRadius,
      Math.pow(thicken, 0.78),
    ) * flare
    samples.push({
      position,
      radius,
      burialDepth: 0,
      crossSection: {
        radiusX: radius * 0.94,
        radiusZ: radius * 1.06,
        rotation: phase + t * swing,
        lobeCount: 3,
        lobeStrength: lerpNumber(0.04, 0.13, t),
      },
    })
  }
  return {
    id,
    type: 'root',
    parentId,
    children: [],
    branchOrder: 1,
    age: 0.82,
    vigor: 0.72,
    dominance: 0.6,
    attachment: clamp(attachment, 0, 1),
    junctionType: 'root-flare',
    aerial: true,
    spine: samples,
  }
}

/**
 * Ground anchors for a cohort of pillars, arranged as a few fused columns.
 *
 * A banyan does not stand on a ring of separate stilts. Its aerial roots reach
 * the ground in groups, thicken together and fuse into a handful of braided
 * columns, which is why a mature one reads as a grove rather than as a tree on
 * legs. Anchors are therefore clustered, not spread evenly.
 */
export function pillarAnchors(
  count: number,
  centre: TreeVec3,
  innerRadius: number,
  outerRadius: number,
  random: TreeRandom,
): TreeVec3[] {
  const anchors: TreeVec3[] = []
  const phase = random.range(0, Math.PI * 2)
  for (let index = 0; index < count; index += 1) {
    const angle = phase + (index / count) * Math.PI * 2 + random.range(-0.42, 0.42)
    const reach = lerpNumber(innerRadius, outerRadius, Math.pow(random.unit(), 0.6))
    anchors.push(vec3(
      centre.x + Math.cos(angle) * reach,
      centre.y,
      centre.z + Math.sin(angle) * reach,
    ))
  }
  return anchors
}

/**
 * Re-fits every aerial root to the wood it actually hangs from.
 *
 * Support roots are authored before the radius inheritance pass, which scales
 * an over-subscribed limb down to fit its own parent's area budget. A pillar
 * sized against the limb's original girth is then wider than the branch it
 * hangs from, and reads as a pole pushed through the canopy however carefully
 * it was proportioned when it was built. Only the upper span is corrected: the
 * foot is anchored in soil and its girth has nothing to do with the carrier.
 */
export function fitAerialRootsToCarriers(
  parts: readonly SemanticTreePart[],
  limit = 0.7,
): void {
  const byId = new Map(parts.map((part) => [part.id, part]))
  for (const root of parts) {
    if (!root.aerial || root.spine.length < 2) continue
    const carrier = root.parentId ? byId.get(root.parentId) : undefined
    if (!carrier || carrier.spine.length === 0) continue
    const last = carrier.spine.length - 1
    const scaled = clamp(root.attachment, 0, 1) * last
    const left = Math.floor(scaled)
    const right = Math.min(last, left + 1)
    const carrierRadius = lerpNumber(
      carrier.spine[left]!.radius,
      carrier.spine[right]!.radius,
      scaled - left,
    )
    const top = root.spine[0]!.radius
    if (top <= carrierRadius * limit) continue
    const correction = (carrierRadius * limit) / Math.max(1e-5, top)
    const count = root.spine.length - 1
    for (const [index, sample] of root.spine.entries()) {
      const factor = lerpNumber(
        correction,
        1,
        smoothstep(0, 0.55, index / Math.max(1, count)),
      )
      sample.radius *= factor
      sample.crossSection.radiusX *= factor
      sample.crossSection.radiusZ *= factor
    }
  }
}
