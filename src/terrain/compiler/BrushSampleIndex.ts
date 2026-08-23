import type { Vec3Like } from '../core/types'
import type {
  BrushStrokeModifier,
  WeightPaintModifier,
} from '../modifiers/types'

type SampleModifier = BrushStrokeModifier | WeightPaintModifier
type BucketKey = number | string

interface SampleIndex {
  dimensions: 2 | 3
  cellSize: number
  pointCount: number
  buckets: Map<BucketKey, number[]>
  scratch: number[]
}

const indices = new WeakMap<SampleModifier, SampleIndex>()
const indexedBrushSupport = new WeakMap<BrushStrokeModifier, boolean>()
const PACKED_AXIS_SIZE = 1 << 17
const PACKED_AXIS_ORIGIN = PACKED_AXIS_SIZE >> 1

/**
 * Candidate samples for one exact influence test, returned in authored order.
 * False positives at bucket edges are intentional; the caller retains the
 * original distance test, while false negatives are forbidden.
 */
export function nearbyBrushSampleIndices(
  modifier: SampleModifier,
  point: Vec3Like,
  radius = modifier.radius,
): readonly number[] {
  if (modifier.points.length === 0) return []
  const index = sampleIndex(modifier)
  const scratch = index.scratch
  scratch.length = 0
  const minimumX = Math.floor((point.x - radius) / index.cellSize)
  const maximumX = Math.floor((point.x + radius) / index.cellSize)
  const minimumZ = Math.floor((point.z - radius) / index.cellSize)
  const maximumZ = Math.floor((point.z + radius) / index.cellSize)
  const minimumY = index.dimensions === 3
    ? Math.floor((point.y - radius) / index.cellSize)
    : 0
  const maximumY = index.dimensions === 3
    ? Math.floor((point.y + radius) / index.cellSize)
    : 0

  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let z = minimumZ; z <= maximumZ; z += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        const bucket = index.buckets.get(bucketKey(x, y, z, index.dimensions))
        if (bucket) scratch.push(...bucket)
      }
    }
  }
  // A query spans several buckets. Each bucket is insertion ordered, and this
  // merge restores the single authored order required by nonlinear brushes.
  scratch.sort(compareNumbers)
  return scratch
}

/** Whether per-vertex brush evaluation can safely omit distant samples. */
export function supportsIndexedBrushEvaluation(
  modifier: BrushStrokeModifier,
): boolean {
  const existing = indexedBrushSupport.get(modifier)
  if (existing !== undefined) return existing
  if (modifier.domain !== 'heightfield' || modifier.mode === 'pinch') {
    indexedBrushSupport.set(modifier, false)
    return false
  }
  if (modifier.mode === 'smooth' || modifier.mode === 'terrace') {
    indexedBrushSupport.set(modifier, true)
    return true
  }
  // Every other mode displaces along the authored sample normal. X/Z must stay
  // invariant for the initial spatial query to remain valid throughout the
  // ordered sequence of dabs.
  const supported = modifier.points.every(
    (sample) =>
      (sample.normal?.x ?? 0) === 0 &&
      (sample.normal?.z ?? 0) === 0,
  )
  indexedBrushSupport.set(modifier, supported)
  return supported
}

export function hasNearbyBrushSample(
  modifier: BrushStrokeModifier,
  point: Vec3Like,
  radius: number,
): boolean {
  for (const index of nearbyBrushSampleIndices(modifier, point, radius)) {
    const sample = modifier.points[index]
    const dx = point.x - sample.x
    const dz = point.z - sample.z
    const distance = modifier.domain === 'heightfield'
      ? Math.hypot(dx, dz)
      : Math.hypot(dx, point.y - sample.y, dz)
    if (distance <= radius) return true
  }
  return false
}

function sampleIndex(modifier: SampleModifier): SampleIndex {
  const existing = indices.get(modifier)
  const dimensions =
    modifier.type === 'brush-stroke' && modifier.domain === 'heightfield'
      ? 2
      : 3
  const cellSize = Math.max(0.001, modifier.radius)
  if (
    existing &&
    existing.dimensions === dimensions &&
    existing.cellSize === cellSize &&
    existing.pointCount === modifier.points.length
  ) {
    return existing
  }
  const index: SampleIndex = {
    dimensions,
    cellSize,
    pointCount: modifier.points.length,
    buckets: new Map(),
    scratch: [],
  }
  for (let pointIndex = 0; pointIndex < modifier.points.length; pointIndex += 1) {
    const point = modifier.points[pointIndex]
    const x = Math.floor(point.x / index.cellSize)
    const y = dimensions === 3 ? Math.floor(point.y / index.cellSize) : 0
    const z = Math.floor(point.z / index.cellSize)
    const key = bucketKey(x, y, z, dimensions)
    const bucket = index.buckets.get(key)
    if (bucket) bucket.push(pointIndex)
    else index.buckets.set(key, [pointIndex])
  }
  indices.set(modifier, index)
  return index
}

function bucketKey(x: number, y: number, z: number, dimensions: 2 | 3): BucketKey {
  const packedX = x + PACKED_AXIS_ORIGIN
  const packedY = y + PACKED_AXIS_ORIGIN
  const packedZ = z + PACKED_AXIS_ORIGIN
  if (
    packedX >= 0 && packedX < PACKED_AXIS_SIZE &&
    packedZ >= 0 && packedZ < PACKED_AXIS_SIZE &&
    (dimensions === 2 || (packedY >= 0 && packedY < PACKED_AXIS_SIZE))
  ) {
    return dimensions === 2
      ? packedX * PACKED_AXIS_SIZE + packedZ
      : (packedX * PACKED_AXIS_SIZE + packedY) * PACKED_AXIS_SIZE + packedZ
  }
  return dimensions === 2 ? `${x}:${z}` : `${x}:${y}:${z}`
}

function compareNumbers(a: number, b: number): number {
  return a - b
}
