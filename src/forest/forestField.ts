import type { ForestPresetId } from '../tree/forestPresets'

/**
 * A forest, described as a shape on the ground rather than as a list of trees.
 *
 * This is the authoritative record: the stems, the boulders and the ground
 * cover inside it are all derived from it and can be thrown away and rebuilt at
 * any time. That is what makes dragging a spline node cheap — moving a control
 * point rewrites four numbers, and nothing regenerates until the field is
 * explicitly grown again.
 */
export interface ForestField {
  id: string
  name: string
  /** Control points on the ground plane. Height comes from the terrain. */
  nodes: readonly ForestFieldNode[]
  /** A closed loop is an area; an open spline is a belt of `width` either side. */
  closed: boolean
  /** Half-width of an open belt, in metres. Ignored when `closed`. */
  width: number
  /**
   * Metres the stand and its floor fade across at the boundary, centred on it.
   *
   * The single most important number in the whole field. A hard edge is what
   * makes a painted forest read as a decal: the ground texture changes along a
   * surveyed line, the stems stop dead, and the eye finds the line instantly.
   * A real wood has a fringe tens of metres deep where the stems thin, the
   * canopy opens and the litter gives way to whatever is outside.
   */
  feather: number
  preset: ForestPresetId
  /** Multiplier on the preset's stems per hectare. */
  density: number
  seed: number
  visible: boolean
  /** True when the spline has moved since the field was last grown. */
  dirty: boolean
}

export interface ForestFieldNode {
  x: number
  z: number
}

/** Metres between samples of the interpolated spline. */
const SPLINE_SAMPLE_SPACING = 2

/**
 * The spline as a polyline.
 *
 * Centripetal Catmull-Rom, which is the one variant that cannot loop or cusp
 * when two control points are dragged close together — and dragging control
 * points close together is exactly what a user does when tightening a corner.
 */
export function sampleForestSpline(
  nodes: readonly ForestFieldNode[],
  closed: boolean,
): ForestFieldNode[] {
  if (nodes.length === 0) return []
  if (nodes.length === 1) return [{ ...nodes[0]! }]
  if (nodes.length === 2) {
    return closed ? [{ ...nodes[0]! }, { ...nodes[1]! }] : subdivideSegment(nodes[0]!, nodes[1]!)
  }

  const points: ForestFieldNode[] = []
  const count = closed ? nodes.length : nodes.length - 1
  for (let index = 0; index < count; index += 1) {
    const p0 = nodes[wrap(index - 1, nodes.length, closed)]!
    const p1 = nodes[wrap(index, nodes.length, closed)]!
    const p2 = nodes[wrap(index + 1, nodes.length, closed)]!
    const p3 = nodes[wrap(index + 2, nodes.length, closed)]!
    const span = Math.hypot(p2.x - p1.x, p2.z - p1.z)
    const steps = Math.max(2, Math.ceil(span / SPLINE_SAMPLE_SPACING))
    for (let step = 0; step < steps; step += 1) {
      points.push(catmullRom(p0, p1, p2, p3, step / steps))
    }
  }
  if (!closed) points.push({ ...nodes[nodes.length - 1]! })
  return points
}

function subdivideSegment(a: ForestFieldNode, b: ForestFieldNode): ForestFieldNode[] {
  const span = Math.hypot(b.x - a.x, b.z - a.z)
  const steps = Math.max(1, Math.ceil(span / SPLINE_SAMPLE_SPACING))
  const points: ForestFieldNode[] = []
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    points.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })
  }
  return points
}

function wrap(index: number, length: number, closed: boolean): number {
  if (closed) return ((index % length) + length) % length
  return Math.min(length - 1, Math.max(0, index))
}

/** Centripetal parameterisation, so a tight corner stays a corner. */
function catmullRom(
  p0: ForestFieldNode,
  p1: ForestFieldNode,
  p2: ForestFieldNode,
  p3: ForestFieldNode,
  t: number,
): ForestFieldNode {
  const t0 = 0
  const t1 = t0 + knot(p0, p1)
  const t2 = t1 + knot(p1, p2)
  const t3 = t2 + knot(p2, p3)
  const time = t1 + (t2 - t1) * t
  const a1 = blend(p0, p1, t0, t1, time)
  const a2 = blend(p1, p2, t1, t2, time)
  const a3 = blend(p2, p3, t2, t3, time)
  const b1 = blend(a1, a2, t0, t2, time)
  const b2 = blend(a2, a3, t1, t3, time)
  return blend(b1, b2, t1, t2, time)
}

function knot(a: ForestFieldNode, b: ForestFieldNode): number {
  // Centripetal: the square root of the chord length, floored so coincident
  // control points cannot divide by zero.
  return Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)))
}

function blend(
  a: ForestFieldNode,
  b: ForestFieldNode,
  ta: number,
  tb: number,
  t: number,
): ForestFieldNode {
  const span = tb - ta
  if (Math.abs(span) < 1e-9) return { ...a }
  const w = (tb - t) / span
  return {
    x: a.x * w + b.x * (1 - w),
    z: a.z * w + b.z * (1 - w),
  }
}

export interface ForestRegionBounds {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/**
 * A field's coverage, baked to a raster once and read back by everything that
 * needs it.
 *
 * Three consumers ask the same question — where do stems go, where does the
 * floor recipe get painted, and how strongly does the terrain surface blend
 * toward forest litter — and all three ask it hundreds of thousands of times.
 * Answering each query against the spline itself means a distance-to-polyline
 * search per sample; answering it against a raster is two multiplies and a
 * lerp, and the raster costs one pass over a few hundred thousand cells.
 */
export class ForestRegion {
  readonly bounds: ForestRegionBounds
  readonly cell: number
  readonly columns: number
  readonly rows: number
  /** Coverage in 0..1, row-major from `bounds.min`. */
  readonly data: Float32Array
  /** Coverage-weighted area in square metres. */
  readonly area: number

  constructor(
    bounds: ForestRegionBounds,
    cell: number,
    columns: number,
    rows: number,
    data: Float32Array,
  ) {
    this.bounds = bounds
    this.cell = cell
    this.columns = columns
    this.rows = rows
    this.data = data
    let sum = 0
    for (const value of data) sum += value
    this.area = sum * cell * cell
  }

  /** Bilinear, and zero everywhere outside the raster. */
  coverage(x: number, z: number): number {
    const fx = (x - this.bounds.minX) / this.cell - 0.5
    const fz = (z - this.bounds.minZ) / this.cell - 0.5
    if (fx < -1 || fz < -1 || fx > this.columns || fz > this.rows) return 0
    const x0 = Math.floor(fx)
    const z0 = Math.floor(fz)
    const tx = fx - x0
    const tz = fz - z0
    const a = this.at(x0, z0)
    const b = this.at(x0 + 1, z0)
    const c = this.at(x0, z0 + 1)
    const d = this.at(x0 + 1, z0 + 1)
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz
  }

  private at(column: number, row: number): number {
    if (column < 0 || row < 0 || column >= this.columns || row >= this.rows) return 0
    return this.data[row * this.columns + column]!
  }
}

/** Raster cells along the longest side. Keeps the bake bounded on huge fields. */
const MAX_REGION_RESOLUTION = 512

/** Metres per raster cell at the finest. Below this the raster buys nothing. */
const MIN_REGION_CELL = 1

export function buildForestRegion(field: ForestField): ForestRegion | null {
  const polyline = sampleForestSpline(field.nodes, field.closed)
  if (polyline.length < 2) return null

  const reach = (field.closed ? 0 : field.width) + field.feather * 0.5 + 2
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const point of polyline) {
    minX = Math.min(minX, point.x)
    minZ = Math.min(minZ, point.z)
    maxX = Math.max(maxX, point.x)
    maxZ = Math.max(maxZ, point.z)
  }
  const bounds: ForestRegionBounds = {
    minX: minX - reach,
    minZ: minZ - reach,
    maxX: maxX + reach,
    maxZ: maxZ + reach,
  }

  const width = bounds.maxX - bounds.minX
  const depth = bounds.maxZ - bounds.minZ
  const cell = Math.max(
    MIN_REGION_CELL,
    Math.max(width, depth) / MAX_REGION_RESOLUTION,
  )
  const columns = Math.max(1, Math.ceil(width / cell))
  const rows = Math.max(1, Math.ceil(depth / cell))
  const data = new Float32Array(columns * rows)

  const segments = polylineSegments(polyline, field.closed)
  const grid = new SegmentGrid(segments, Math.max(cell * 2, reach))
  const inside = field.closed
    ? scanlineInterior(segments, bounds, cell, columns, rows)
    : null

  const half = Math.max(0.5, field.feather * 0.5)
  for (let row = 0; row < rows; row += 1) {
    const z = bounds.minZ + (row + 0.5) * cell
    for (let column = 0; column < columns; column += 1) {
      const x = bounds.minX + (column + 0.5) * cell
      const distance = grid.distance(x, z)
      const signed = field.closed
        ? (inside![row * columns + column] === 1 ? distance : -distance)
        : field.width - distance
      data[row * columns + column] = smoothstep(-half, half, signed)
    }
  }

  return new ForestRegion(bounds, cell, columns, rows, data)
}

interface Segment {
  ax: number
  az: number
  bx: number
  bz: number
}

function polylineSegments(
  polyline: readonly ForestFieldNode[],
  closed: boolean,
): Segment[] {
  const segments: Segment[] = []
  const count = closed ? polyline.length : polyline.length - 1
  for (let index = 0; index < count; index += 1) {
    const a = polyline[index]!
    const b = polyline[(index + 1) % polyline.length]!
    segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z })
  }
  return segments
}

/**
 * Distance to the spline, bucketed.
 *
 * The raster is up to a quarter of a million cells and a long spline is a
 * thousand segments; testing every segment against every cell is a quarter of a
 * billion distance evaluations for one drag. Bucketing by a cell at least as
 * large as the distance anybody cares about means the answer is always in the
 * nine buckets around the query, and the search only widens where the field is
 * genuinely far from its own boundary — which is the interior, where the exact
 * distance no longer changes the result.
 */
class SegmentGrid {
  private readonly cell: number
  private readonly buckets = new Map<number, Segment[]>()

  constructor(segments: readonly Segment[], cell: number) {
    this.cell = Math.max(1, cell)
    for (const segment of segments) {
      const minX = Math.floor(Math.min(segment.ax, segment.bx) / this.cell)
      const maxX = Math.floor(Math.max(segment.ax, segment.bx) / this.cell)
      const minZ = Math.floor(Math.min(segment.az, segment.bz) / this.cell)
      const maxZ = Math.floor(Math.max(segment.az, segment.bz) / this.cell)
      for (let gz = minZ; gz <= maxZ; gz += 1) {
        for (let gx = minX; gx <= maxX; gx += 1) {
          const key = SegmentGrid.key(gx, gz)
          const bucket = this.buckets.get(key)
          if (bucket) bucket.push(segment)
          else this.buckets.set(key, [segment])
        }
      }
    }
  }

  private static key(gx: number, gz: number): number {
    return (Math.imul(gx, 0x45d9f3b) ^ Math.imul(gz, 0x27d4eb2d)) | 0
  }

  distance(x: number, z: number): number {
    const gx = Math.floor(x / this.cell)
    const gz = Math.floor(z / this.cell)
    let best = Infinity
    // Widening rings. Two are almost always enough; the loop exists so an
    // interior cell far from every segment still gets a finite answer.
    for (let ring = 1; ring <= 24; ring += 1) {
      for (let dz = -ring; dz <= ring; dz += 1) {
        for (let dx = -ring; dx <= ring; dx += 1) {
          if (ring > 1 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue
          const bucket = this.buckets.get(SegmentGrid.key(gx + dx, gz + dz))
          if (!bucket) continue
          for (const segment of bucket) {
            best = Math.min(best, distanceToSegment(x, z, segment))
          }
        }
      }
      // One more ring than the one that found something: a segment in a
      // diagonal bucket can still be nearer than one found straight ahead.
      if (best < ring * this.cell) return best
    }
    return best
  }
}

function distanceToSegment(x: number, z: number, segment: Segment): number {
  const dx = segment.bx - segment.ax
  const dz = segment.bz - segment.az
  const lengthSq = dx * dx + dz * dz
  const t = lengthSq < 1e-9
    ? 0
    : Math.min(1, Math.max(0, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq))
  return Math.hypot(x - (segment.ax + dx * t), z - (segment.az + dz * t))
}

/**
 * Interior of a closed loop, filled a row at a time.
 *
 * Even-odd crossing per cell would be one pass over every segment for every
 * cell. Per row it is one pass over every segment for every *row*, and the
 * spans between sorted crossings fill in constant time — the difference
 * between a hundred million tests and a quarter of a million on a large field.
 */
function scanlineInterior(
  segments: readonly Segment[],
  bounds: ForestRegionBounds,
  cell: number,
  columns: number,
  rows: number,
): Uint8Array {
  const inside = new Uint8Array(columns * rows)
  const crossings: number[] = []
  for (let row = 0; row < rows; row += 1) {
    const z = bounds.minZ + (row + 0.5) * cell
    crossings.length = 0
    for (const segment of segments) {
      const { az, bz } = segment
      if ((az <= z && bz > z) || (bz <= z && az > z)) {
        const t = (z - az) / (bz - az)
        crossings.push(segment.ax + (segment.bx - segment.ax) * t)
      }
    }
    if (crossings.length < 2) continue
    crossings.sort((a, b) => a - b)
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = Math.max(0, Math.ceil((crossings[pair]! - bounds.minX) / cell - 0.5))
      const to = Math.min(
        columns - 1,
        Math.floor((crossings[pair + 1]! - bounds.minX) / cell - 0.5),
      )
      for (let column = from; column <= to; column += 1) inside[row * columns + column] = 1
    }
  }
  return inside
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}
