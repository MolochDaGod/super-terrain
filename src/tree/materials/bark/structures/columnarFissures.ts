import { hash2, positiveModulo } from '../../proceduralNoise'

export interface ColumnarFissureSample {
  /** Distance to the nearest retained plate boundary. */
  majorBorder: number
  /** Orientation-weighted depth: longitudinal edges dominate. */
  majorStrength: number
  /** Kept for the shared field interface; this structure needs no drawn links. */
  crossBreakBorder: number
  /** Stable identity for weathering and relief variation on this plate. */
  plateIdentity: number
}

interface Feature {
  distanceSquared: number
  x: number
  y: number
  cellX: number
  cellY: number
}

/**
 * How far, in cell units, a second boundary has to be behind the nearest one
 * before it stops contributing to the orientation blend. Small enough that a
 * plate's own edge dominates everywhere except within a junction.
 */
const JUNCTION_BLEND = 0.018

function smooth(value: number): number {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped * clamped * (3 - 2 * clamped)
}

/**
 * An orientation-aware, anisotropic plate field for mature hardwood bark.
 *
 * A normal Voronoi border closes every plate with equally dark edges and reads
 * as mud or reptile skin. Independent vertical lines avoid that failure but
 * cannot branch or end, so they read as routed grooves. This field retains the
 * topology of a true plate network while weighting each boundary by its
 * orientation: longitudinal edges open deeply, diagonal edges taper, and
 * transverse edges mostly close. Branches and triple junctions therefore come
 * from the structure itself instead of from a second set of drawn crossbars.
 */
export function sampleColumnarFissures(
  u: number,
  v: number,
  columns: number,
  verticalSegments: number,
  seed: number,
  transverseStrength = 0,
): ColumnarFissureSample {
  const rows = Math.max(2, Math.round(verticalSegments))
  const x = u * columns + 5.7
  const y = v * rows - 2.3
  const features: Feature[] = []
  let nearest: Feature | undefined
  let second: Feature | undefined

  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    const sourceY = Math.floor(y) + offsetY
    const wrappedY = positiveModulo(sourceY, rows)
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const sourceX = Math.floor(x) + offsetX
      const wrappedX = positiveModulo(sourceX, columns)
      const featureX = sourceX + 0.12 + hash2(wrappedX, wrappedY, seed + 83) * 0.76
      const featureY = sourceY + 0.12 + hash2(wrappedX, wrappedY, seed + 109) * 0.76
      const dx = featureX - x
      const dy = featureY - y
      const feature: Feature = {
        distanceSquared: dx * dx + dy * dy,
        x: featureX,
        y: featureY,
        cellX: wrappedX,
        cellY: wrappedY,
      }
      features.push(feature)
      if (!nearest || feature.distanceSquared < nearest.distanceSquared) {
        second = nearest
        nearest = feature
      } else if (!second || feature.distanceSquared < second.distanceSquared) {
        second = feature
      }
    }
  }

  const first = nearest!
  const other = second!
  const nearestDistance = Math.sqrt(first.distanceSquared)
  const majorBorder = (Math.sqrt(other.distanceSquared) - nearestDistance) * 0.5

  // Orientation, blended across every boundary this texel is near rather than
  // read off the single second-nearest feature.
  //
  // Taking it from one pair makes the whole term jump the instant the identity
  // of that pair changes, which happens along the bisector of every triple
  // junction. The result is a fissure network whose depth flips abruptly in
  // mid-run: on the trunk it reads as a chevron or herringbone weave rather
  // than as bark. Weighting by proximity to each boundary fixes the
  // discontinuity without softening the field elsewhere, because away from a
  // junction one boundary dominates the kernel completely and its own
  // orientation still comes through undiluted.
  let weightedStrength = 0
  let totalWeight = 0
  for (const feature of features) {
    if (feature === first) continue
    const boundary = (Math.sqrt(feature.distanceSquared) - nearestDistance) * 0.5
    const weight = Math.exp(-(boundary - majorBorder) / JUNCTION_BLEND)
    if (weight < 1e-4) continue
    const featureDx = Math.abs(feature.x - first.x)
    const featureDy = Math.abs(feature.y - first.y)
    // The vector between adjacent feature points is the boundary normal. A
    // large x component therefore means the boundary itself runs vertically.
    const longitudinal = featureDx / Math.max(1e-6, featureDx + featureDy)
    const orientation = smooth((longitudinal - 0.08) / 0.78)
    weightedStrength += (transverseStrength + orientation * (1 - transverseStrength)) * weight
    totalWeight += weight
  }

  return {
    majorBorder,
    majorStrength: totalWeight > 0 ? weightedStrength / totalWeight : 0,
    crossBreakBorder: Number.POSITIVE_INFINITY,
    plateIdentity: hash2(first.cellX, first.cellY, seed + 97),
  }
}
