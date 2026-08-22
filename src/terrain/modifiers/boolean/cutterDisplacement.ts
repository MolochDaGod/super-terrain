import type { BufferAttribute, BufferGeometry } from 'three'
import type { CutterVolume } from './CutterVolume'

/**
 * Roughens a cutter before it is subtracted.
 *
 * A boolean cuts an exact surface, which is its great advantage over a lattice
 * mesher and also its one tell: subtract an analytic capsule and you get a
 * machined bore, subtract an ellipsoid and you get a hole punched by a die. Real
 * rock voids are none of those. So the *cutter itself* is displaced before the
 * boolean runs, and the exactness then works in our favour — it reproduces the
 * roughened surface precisely instead of quantising it.
 *
 * The displacement is deliberately two fields with different jobs:
 *
 *   Worley  — cellular, and the important one. Its cells read as the scallops
 *             and dissolution pockets that line a real conduit, and its ridges
 *             read as the rib between two pockets. No amount of fBm produces
 *             that; fBm alone gives a smoothly wobbling tube.
 *   fBm     — a few large, slow undulations so the passage widens and narrows
 *             along its length rather than holding one calibre.
 *
 * Everything is evaluated in **world space**, so a formation spanning a section
 * boundary is displaced identically by both sections and the seam stays closed.
 */

/**
 * Total displacement as a fraction of the cutter's smallest radius.
 *
 * The shapes are star-shaped about their own centre or axis and are displaced
 * along that radial direction, so they stay closed and non-self-intersecting as
 * long as the displacement cannot reach the centre. Past roughly a third of the
 * radius the surface starts folding through itself and the boolean produces
 * shards instead of a cave.
 */
const MAX_DISPLACEMENT_FRACTION = 0.12

export interface DisplacementProfile {
  /** Wavelength of the cellular field, in metres. */
  cellSize: number
  /** Share of the budget spent on pockets rather than on undulation. */
  cellular: number
  /** Wavelength of the slow undulation, in metres. */
  swellSize: number
}

/** Per-formation character. A canyon is not scalloped the way a conduit is. */
export const DISPLACEMENT_PROFILES: Record<string, DisplacementProfile> = {
  // Phreatic passages are strongly scalloped at close to a metre.
  cave: { cellSize: 2.6, cellular: 0.72, swellSize: 17 },
  // A wind-scoured span is smoother and undulates over tens of metres.
  arch: { cellSize: 5.5, cellular: 0.5, swellSize: 34 },
  // An undercut is eaten out along the bed: broad hollows, shallow pockets.
  overhang: { cellSize: 4.2, cellular: 0.58, swellSize: 22 },
  // Water-polished slot walls are fluted rather than pocketed.
  canyon: { cellSize: 7, cellular: 0.34, swellSize: 26 },
  hoodoo: { cellSize: 3.4, cellular: 0.62, swellSize: 15 },
  default: { cellSize: 4, cellular: 0.55, swellSize: 20 },
}

/**
 * Displaces a world-space cutter geometry in place.
 *
 * `cutter` supplies the radial frame: displacing along the interpolated vertex
 * normal would tear the mesh open at its seams, because a capsule's seam holds
 * two coincident vertices carrying different normals. Deriving the direction
 * from the position instead gives coincident vertices identical displacement,
 * which is what keeps the solid watertight and the boolean well defined.
 */
export function displaceCutterGeometry(
  geometry: BufferGeometry,
  cutter: CutterVolume,
  profile: DisplacementProfile,
  seed: number,
): void {
  const position = geometry.getAttribute('position') as BufferAttribute
  const array = position.array as Float32Array
  const noise = cutterNoise(cutter)
  const budget = cutterRadius(cutter) * MAX_DISPLACEMENT_FRACTION * noise
  if (budget < 0.05) return

  const closeScale = Math.max(0.25, cutter.noiseScale ?? profile.cellSize)
  const scaleRatio = closeScale / profile.cellSize

  const cellularShare = budget * profile.cellular
  const swellShare = budget * (1 - profile.cellular)

  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const offset = vertex * 3
    const x = array[offset]
    const y = array[offset + 1]
    const z = array[offset + 2]

    const direction = radialDirection(cutter, x, y, z)
    if (!direction) continue

    // Worley F2 - F1: near zero inside a cell and rising towards its border, so
    // the cell interiors become the pockets and the borders the ribs between
    // them. Plain F1 gives cones pointing at every cell centre, which reads as
    // studded rather than scalloped.
    const cell = worley3(
      x / closeScale,
      y / closeScale,
      z / closeScale,
      seed,
    )
    const pocket = 1 - Math.min(1, (cell.second - cell.nearest) * 1.6)
    const swell = fbm3(
      x / (profile.swellSize * scaleRatio),
      y / (profile.swellSize * scaleRatio),
      z / (profile.swellSize * scaleRatio),
      seed + 977,
      3,
    )

    // Outward only. Displacing inward would leave rock standing inside the
    // passage as detached slivers the boolean has to resolve.
    const push = pocket * cellularShare + (swell * 0.5 + 0.5) * swellShare

    array[offset] = x + direction.x * push
    array[offset + 1] = y + direction.y * push
    array[offset + 2] = z + direction.z * push
  }

  position.needsUpdate = true
  geometry.computeVertexNormals()
}

/**
 * Metres the roughening can push a cutter's surface beyond its analytic shape.
 *
 * Bounds computed for a cutter must include this. The displacement is outward
 * only, so a volume that appears to stop short of a section boundary can in
 * fact cross it — and then the neighbouring section, which was never told the
 * formation reached that far, does not subtract it and the shared edge tears.
 */
export function cutterDisplacementBudget(cutter: CutterVolume): number {
  if (cutter.surface === 'none' || cutter.kind === 'mesh') return 0
  return cutterRadius(cutter) * MAX_DISPLACEMENT_FRACTION * cutterNoise(cutter)
}

function cutterNoise(cutter: CutterVolume): number {
  return Math.max(0, Math.min(2.5, cutter.noise ?? 1))
}

/** Smallest radius of the cutter; the displacement budget scales from it. */
function cutterRadius(cutter: CutterVolume): number {
  if (cutter.kind === 'mesh') return 0
  if (cutter.kind === 'sweep') {
    let radius = Infinity
    for (const ring of cutter.rings) {
      radius = Math.min(radius, ring.horizontalRadius, ring.verticalRadius)
    }
    return Number.isFinite(radius) ? radius : 0
  }
  if (cutter.kind === 'capsule') return cutter.radius
  const size = cutter.kind === 'ellipsoid' ? cutter.radii : cutter.halfExtents
  return Math.min(size.x, size.y, size.z)
}

/**
 * Outward direction at a point on the cutter's surface, derived from geometry
 * rather than from the stored normal so seam duplicates agree exactly.
 */
function radialDirection(
  cutter: CutterVolume,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } | null {
  if (cutter.kind === 'mesh') return null
  if (cutter.kind === 'sweep') {
    let nearest = cutter.rings[0]
    let nearestDistance = Infinity
    for (const ring of cutter.rings) {
      const distance =
        (x - ring.x) * (x - ring.x) +
        (y - ring.y) * (y - ring.y) +
        (z - ring.z) * (z - ring.z)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = ring
      }
    }
    if (!nearest) return null
    return normalize(x - nearest.x, y - nearest.y, z - nearest.z)
  }
  if (cutter.kind === 'capsule') {
    // Perpendicular from the axis segment, which is the capsule's own normal
    // everywhere except exactly on the end caps, where it becomes radial from
    // the cap centre — both are continuous across the join.
    const ax = cutter.end.x - cutter.start.x
    const ay = cutter.end.y - cutter.start.y
    const az = cutter.end.z - cutter.start.z
    const lengthSquared = ax * ax + ay * ay + az * az
    let t = 0
    if (lengthSquared > 1e-8) {
      t =
        ((x - cutter.start.x) * ax +
          (y - cutter.start.y) * ay +
          (z - cutter.start.z) * az) /
        lengthSquared
      t = Math.max(0, Math.min(1, t))
    }
    return normalize(
      x - (cutter.start.x + ax * t),
      y - (cutter.start.y + ay * t),
      z - (cutter.start.z + az * t),
    )
  }

  const size = cutter.kind === 'ellipsoid' ? cutter.radii : cutter.halfExtents
  // Normalised in the shape's own metric, so a flattened notch is pushed out
  // mostly across its thin axis rather than along its length.
  return normalize(
    (x - cutter.center.x) / (size.x * size.x),
    (y - cutter.center.y) / (size.y * size.y),
    (z - cutter.center.z) / (size.z * size.z),
  )
}

function normalize(
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } | null {
  const length = Math.hypot(x, y, z)
  if (length < 1e-6) return null
  return { x: x / length, y: y / length, z: z / length }
}

/**
 * Cellular noise. Returns the distances to the nearest and second-nearest
 * feature points, which together describe both where a cell is and where its
 * border is.
 */
function worley3(
  x: number,
  y: number,
  z: number,
  seed: number,
): { nearest: number; second: number } {
  const baseX = Math.floor(x)
  const baseY = Math.floor(y)
  const baseZ = Math.floor(z)
  let nearest = 8
  let second = 8

  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const cellX = baseX + dx
        const cellY = baseY + dy
        const cellZ = baseZ + dz
        const featureX = cellX + hash3(cellX, cellY, cellZ, seed)
        const featureY = cellY + hash3(cellX, cellY, cellZ, seed + 17)
        const featureZ = cellZ + hash3(cellX, cellY, cellZ, seed + 41)
        const distance = Math.hypot(x - featureX, y - featureY, z - featureZ)
        if (distance < nearest) {
          second = nearest
          nearest = distance
        } else if (distance < second) {
          second = distance
        }
      }
    }
  }
  return { nearest, second }
}

/** Signed value-noise fBm in roughly [-1, 1]. */
function fbm3(
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves: number,
): number {
  let sum = 0
  let total = 0
  let amplitude = 1
  let frequency = 1
  for (let octave = 0; octave < octaves; octave += 1) {
    sum +=
      valueNoise3(x * frequency, y * frequency, z * frequency, seed + octave * 31) *
      amplitude
    total += amplitude
    amplitude *= 0.5
    frequency *= 2.03
  }
  return total === 0 ? 0 : (sum / total) * 2 - 1
}

function valueNoise3(
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  const baseX = Math.floor(x)
  const baseY = Math.floor(y)
  const baseZ = Math.floor(z)
  const fx = smoothFraction(x - baseX)
  const fy = smoothFraction(y - baseY)
  const fz = smoothFraction(z - baseZ)

  let result = 0
  for (let dz = 0; dz <= 1; dz += 1) {
    const wz = dz === 0 ? 1 - fz : fz
    for (let dy = 0; dy <= 1; dy += 1) {
      const wy = dy === 0 ? 1 - fy : fy
      for (let dx = 0; dx <= 1; dx += 1) {
        const wx = dx === 0 ? 1 - fx : fx
        result +=
          hash3(baseX + dx, baseY + dy, baseZ + dz, seed) * wx * wy * wz
      }
    }
  }
  return result
}

function smoothFraction(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10)
}

/** Stable hash of an integer lattice point, in [0, 1). */
function hash3(x: number, y: number, z: number, seed: number): number {
  let value = Math.imul(x | 0, 374_761_393)
  value = (value + Math.imul(y | 0, 668_265_263)) | 0
  value = (value + Math.imul(z | 0, 1_274_126_177)) | 0
  value = (value + Math.imul(seed | 0, 1_442_695_041)) | 0
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177)
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296
}
