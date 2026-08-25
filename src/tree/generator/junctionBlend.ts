import { add, clamp, dot, length, multiply, subtract } from './math'
import type { SemanticTreePart, TreeVec3 } from './types'

/**
 * Fused unions for a mesher that sweeps every axis as its own closed shell.
 *
 * A swept tube is a fine model of one piece of wood and a terrible model of the
 * place two pieces meet. Two shells that simply interpenetrate leave the hard
 * intersection curve of two cylinders on the silhouette; the alternative the
 * mesher reached for first — projecting the child's opening ring onto the
 * parent's surface — turns any union thicker than a twig into a circular shelf.
 * Both readings were rejected in review, on a baobab where the divisions are
 * nearly as thick as the bole that carries them.
 *
 * Real wood solves this by laying down reaction tissue in the fork until the
 * concave valley is filled: the branch bark ridge. That is exactly the shape of
 * a smooth-union blend, so this module evaluates one. Each vertex is pushed out
 * along its own radial direction by the amount its shell is buried inside the
 * blended solid of its topological neighbours. The two shells still overlap —
 * they are supposed to, they are one piece of wood — but the crease where they
 * emerge is a swollen, tangent-softened saddle rather than a stamped seam.
 *
 * Only parent, children and near siblings blend. Letting the field see every
 * axis would weld unrelated crossing twigs into webbing.
 */

/** One conical section of an axis, in world space. */
export interface BlendSegment {
  start: TreeVec3
  end: TreeVec3
  startRadius: number
  endRadius: number
}

export interface JunctionNeighbourhood {
  segments: readonly BlendSegment[]
  /** Blend radius in metres, from the thinner member of each union. */
  blendRadius: number
  /** Hard ceiling on the outward push, so an embedded axis cannot balloon. */
  maximumSwell: number
}

/**
 * Fraction of the thinner member's radius used as the fillet radius.
 *
 * A fork's reaction wood is a substantial share of the branch it supports, so
 * this is not a hairline chamfer. Values above about 1.2 start swallowing short
 * side branches whole.
 */
const BLEND_FRACTION = 0.95

/** The largest displacement permitted, as a multiple of the blend radius. */
const SWELL_CEILING = 0.62

/**
 * Signed distance from a point to a round cone: the convex hull of two spheres.
 *
 * This is the correct primitive for a tapering member. A capsule of constant
 * radius reports the wrong surface on anything that tapers quickly, and a
 * segment distance with a lerped radius is not a distance field at all — it
 * over-reports near the ends and the fillet visibly kinks there.
 */
export function roundConeDistance(
  point: TreeVec3,
  segment: BlendSegment,
): number {
  const axis = subtract(segment.end, segment.start)
  const axisLengthSquared = dot(axis, axis)
  if (axisLengthSquared < 1e-12) {
    return length(subtract(point, segment.start)) - segment.startRadius
  }
  const radiusDelta = segment.startRadius - segment.endRadius
  const flankSquared = axisLengthSquared - radiusDelta * radiusDelta
  const inverseSquared = 1 / axisLengthSquared

  const relative = subtract(point, segment.start)
  const along = dot(relative, axis)
  const beyond = along - axisLengthSquared
  const offAxis = subtract(
    multiply(relative, axisLengthSquared),
    multiply(axis, along),
  )
  const offAxisSquared = dot(offAxis, offAxis)
  const alongSquared = along * along * axisLengthSquared
  const beyondSquared = beyond * beyond * axisLengthSquared

  // One comparison per sphere cap decides the region without a second root.
  const capThreshold = Math.sign(radiusDelta) * radiusDelta * radiusDelta *
    offAxisSquared
  if (Math.sign(beyond) * flankSquared * beyondSquared > capThreshold) {
    return Math.sqrt(offAxisSquared + beyondSquared) * inverseSquared -
      segment.endRadius
  }
  if (Math.sign(along) * flankSquared * alongSquared < capThreshold) {
    return Math.sqrt(offAxisSquared + alongSquared) * inverseSquared -
      segment.startRadius
  }
  return (Math.sqrt(Math.max(0, offAxisSquared * flankSquared * inverseSquared)) +
    along * radiusDelta) * inverseSquared - segment.startRadius
}

/** Local radius of a member at the station nearest a point. */
function segmentRadiusNear(point: TreeVec3, segment: BlendSegment): number {
  const axis = subtract(segment.end, segment.start)
  const axisLengthSquared = dot(axis, axis)
  if (axisLengthSquared < 1e-12) return segment.startRadius
  const amount = clamp(
    dot(subtract(point, segment.start), axis) / axisLengthSquared,
    0,
    1,
  )
  return segment.startRadius + (segment.endRadius - segment.startRadius) * amount
}

/**
 * Outward displacement for one surface vertex, in metres.
 *
 * The vertex sits on its own shell, so its own field value is zero. The blended
 * solid reaches `blend` metres further out wherever a neighbour is within the
 * fillet radius, and the vertex has to travel that far to sit on the fused
 * surface instead of inside it. Vertices that are deeply inside a neighbour are
 * capped: they are hidden wood, and letting them chase a distant surface would
 * turn a short embedded axis into a balloon.
 */
export function junctionSwell(
  point: TreeVec3,
  neighbourhood: JunctionNeighbourhood | undefined,
  ownRadius: number,
): number {
  if (!neighbourhood || neighbourhood.segments.length === 0) return 0
  let swell = 0
  for (const segment of neighbourhood.segments) {
    const distance = roundConeDistance(point, segment)
    // Scale each union by its own thinner member rather than by one global
    // number, or a twig union on a bole inherits a metre-wide bead.
    const radius = Math.max(
      0.5 * BLEND_FRACTION * Math.min(ownRadius, segmentRadiusNear(point, segment)),
      Math.min(
        neighbourhood.blendRadius,
        BLEND_FRACTION * Math.min(ownRadius, segmentRadiusNear(point, segment)),
      ),
    )
    if (distance >= radius) continue
    // Quadratic smooth-union offset: -smin(0, distance, radius). Maximal on the
    // intersection curve itself and still climbing on the buried side, so the
    // visible crease always lands on a rising surface and never on a local peak
    // — a peak there would read as a raised lip instead of a filled valley.
    const overlap = clamp((radius - distance) / radius, 0, 2)
    swell = Math.max(swell, overlap * overlap * radius * 0.25)
  }
  return Math.min(swell, neighbourhood.maximumSwell)
}

/** Straight-line length of a part's spine. */
function spineLength(part: SemanticTreePart): number {
  let total = 0
  for (let index = 1; index < part.spine.length; index += 1) {
    total += length(subtract(
      part.spine[index]!.position,
      part.spine[index - 1]!.position,
    ))
  }
  return total
}

function segmentsOf(
  part: SemanticTreePart,
  from: number,
  to: number,
): BlendSegment[] {
  const segments: BlendSegment[] = []
  const last = part.spine.length - 1
  if (last < 1) return segments
  const first = Math.max(0, Math.min(last - 1, Math.floor(from * last)))
  const final = Math.max(first + 1, Math.min(last, Math.ceil(to * last)))
  for (let index = first; index < final; index += 1) {
    const a = part.spine[index]!
    const b = part.spine[index + 1]!
    segments.push({
      start: a.position,
      end: b.position,
      // Members are elliptical and lobed; the blend uses the inscribed radius so
      // the bead never claims to reach past wood that is actually there.
      startRadius: Math.min(a.crossSection.radiusX, a.crossSection.radiusZ),
      endRadius: Math.min(b.crossSection.radiusX, b.crossSection.radiusZ),
    })
  }
  return segments
}

/** Widest radius anywhere on a part. */
function maximumRadius(part: SemanticTreePart): number {
  let radius = 0
  for (const sample of part.spine) radius = Math.max(radius, sample.radius)
  return radius
}

/** Radius at a normalised station along a part. */
function radiusAtStation(part: SemanticTreePart, attachment: number): number {
  const last = part.spine.length - 1
  if (last < 0) return 0
  const scaled = clamp(attachment, 0, 1) * last
  const left = Math.floor(scaled)
  const right = Math.min(last, left + 1)
  const amount = scaled - left
  return part.spine[left]!.radius +
    (part.spine[right]!.radius - part.spine[left]!.radius) * amount
}

/**
 * Assembles the blend neighbourhood for one part.
 *
 * Windows matter as much as membership. A child only needs the span of its
 * parent around its own attachment, and a parent only needs the first stretch
 * of each child — carrying whole axes would let a limb's far end blend with the
 * bole it happens to arch back over.
 */
export function junctionNeighbourhood(
  part: SemanticTreePart,
  partById: ReadonlyMap<string, SemanticTreePart>,
): JunctionNeighbourhood | undefined {
  const segments: BlendSegment[] = []
  const ownRadius = maximumRadius(part)
  if (ownRadius <= 0) return undefined
  let blendRadius = 0

  const parent = part.parentId ? partById.get(part.parentId) : undefined
  // A continuation is already index-stitched to its parent's terminal ring in
  // `woodMesher`; it is one sweep split across semantic parts, not a second
  // solid that needs a smooth union. Including that same centreline here made
  // both sides inflate around every continued fork, producing a necklace of
  // round knuckles along otherwise continuous dichotomous limbs.
  if (
    parent &&
    part.junctionType !== 'continuation' &&
    parent.spine.length > 1
  ) {
    const parentRadius = radiusAtStation(parent, part.attachment)
    const reach = Math.max(parentRadius, ownRadius) * 1.8
    const parentSpan = Math.max(1e-3, spineLength(parent))
    const window = clamp(reach / parentSpan, 0.04, 1)
    segments.push(...segmentsOf(
      parent,
      part.attachment - window,
      part.attachment + window,
    ))
    blendRadius = Math.max(
      blendRadius,
      BLEND_FRACTION * Math.min(ownRadius, parentRadius),
    )
  }

  for (const childId of part.children) {
    const child = partById.get(childId)
    if (!child || child.spine.length < 2) continue
    // See the parent-side rule above. Only the genuinely emerging daughter
    // needs a union; the continuation already shares this part's final ring.
    if (child.junctionType === 'continuation') continue
    const childRadius = maximumRadius(child)
    const childSpan = Math.max(1e-3, spineLength(child))
    // Only the emerging stretch of a child can be in its parent's fork. Kept
    // tight on purpose: a wide window let a limb that leaves the bole at a
    // shallow angle raise a bead along metres of the surface it grazed, which
    // read as a hard shelf wrapped right round the trunk.
    const window = clamp(
      Math.max(childRadius, radiusAtStation(part, child.attachment)) * 1.7 /
        childSpan,
      0.05,
      0.55,
    )
    segments.push(...segmentsOf(child, 0, window))
    blendRadius = Math.max(
      blendRadius,
      BLEND_FRACTION * Math.min(ownRadius, childRadius),
    )
  }

  if (segments.length === 0) return undefined
  return {
    segments,
    blendRadius,
    maximumSwell: blendRadius * SWELL_CEILING,
  }
}

/** Pushes a surface vertex onto the fused union surface. */
export function applyJunctionBlend(
  position: TreeVec3,
  outward: TreeVec3,
  ownRadius: number,
  neighbourhood: JunctionNeighbourhood | undefined,
): TreeVec3 {
  const swell = junctionSwell(position, neighbourhood, ownRadius)
  if (swell <= 1e-5) return position
  return add(position, multiply(outward, swell))
}
