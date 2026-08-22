import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import type { AABB, Vec3Like } from '../../core/types'
import { distanceToAabb } from '../../core/bounds'
import {
  DISPLACEMENT_PROFILES,
  cutterDisplacementBudget,
  displaceCutterGeometry,
} from './cutterDisplacement'

/**
 * The vocabulary of volumes that can be removed from the terrain solid.
 *
 * Every piece of arbitrary topology in this world — cave, arch, undercut,
 * canyon, hoodoo — is the shape of what was taken *away*, because subtraction is
 * the one operation that cuts an exact surface. It needs no lattice, so it does
 * not quantise or round the result the way an isosurface extractor would, and
 * the terrain it cuts into remains the exact analytic heightfield everywhere the
 * cutters do not reach.
 *
 * All coordinates are world space. The backend translates into section-local
 * space when it builds the brush.
 */
export type CutterVolume =
  | SweptCaveCutter
  | CapsuleCutter
  | EllipsoidCutter
  | BoxCutter
  | MeshCutter

interface CutterBase {
  /**
   * Which displacement character to roughen this volume with. A cut left
   * analytic reads as machined, so this is effectively required for anything
   * meant to look like rock.
   */
  surface?: keyof typeof DISPLACEMENT_PROFILES | 'none'
  /** Relative displacement and authored cross-section roughness. */
  noise?: number
  /** Close-noise wavelength in world metres. */
  noiseScale?: number
  /**
   * Material classification for faces exposed by subtraction.
   *
   * The Boolean backend transfers this tag onto the generated terrain
   * vertices. An emissive chamber therefore remains one topologically coherent
   * streamed terrain surface instead of relying on a second backing mesh.
   */
  interior?: 'rock' | 'ember'
  /**
   * Optional terrain-side transition authored with an additive mesh patch.
   *
   * Exact CSG supplies the arbitrary topology, but a bare hard union leaves the
   * untouched height field meeting the operand at one razor-thin curve.  That
   * is topologically valid and still reads like a prop pushed through the
   * ground.  The apron raises the inexpensive source terrain underneath and
   * around the operand before the Boolean is evaluated, giving the final union
   * a broad geological root while retaining the patch's overhangs and holes.
   */
  terrainApron?: TerrainApron
}

/** World-space elliptical footprint used to grow terrain into a mesh patch. */
export interface TerrainApron {
  center: Vec3Like
  /** Long-axis direction. Only X/Z participate in the terrain footprint. */
  forward: Vec3Like
  halfLength: number
  halfWidth: number
  /** Metres outside the authored footprint over which the uplift reaches zero. */
  falloff: number
  /** Maximum vertical terrain displacement in metres. */
  lift: number
}

/** One elliptical cross-section of a continuous authored void. */
export interface SweepRing extends Vec3Like {
  horizontalRadius: number
  verticalRadius: number
}

/**
 * One watertight, continuously varying cave shell.
 *
 * Rings may follow any 3D path and change size independently, so this is the
 * general authored-volume path used for caves, windows and irregular holes.
 * Unlike a chain of overlapping capsules it has no analytic joins for the
 * Boolean to expose as clean circular cuts.
 */
export interface SweptCaveCutter extends CutterBase {
  kind: 'sweep'
  rings: SweepRing[]
}

/** A swept sphere: passages, tubes and the windows punched through fins. */
export interface CapsuleCutter extends CutterBase {
  kind: 'capsule'
  start: Vec3Like
  end: Vec3Like
  radius: number
}

/**
 * A rotated ellipsoid. Flattened against the bedding it becomes the notch that
 * leaves a cliff overhanging; near-spherical it becomes a chamber.
 */
export interface EllipsoidCutter extends CutterBase {
  kind: 'ellipsoid'
  center: Vec3Like
  /** Half-extents along the local x (forward), y (up) and z axes. */
  radii: Vec3Like
  /** World direction the local +x axis points along. */
  forward: Vec3Like
  up?: Vec3Like
}

/** A rotated box, used for the straight-walled reaches of a slot canyon. */
export interface BoxCutter extends CutterBase {
  kind: 'box'
  center: Vec3Like
  halfExtents: Vec3Like
  forward: Vec3Like
  up?: Vec3Like
}

/** Serializable closed triangle mesh used as a non-destructive CSG operand. */
export interface MeshCutter extends CutterBase {
  kind: 'mesh'
  positions: number[]
  indices: number[]
}

export function cloneCutterVolume(cutter: CutterVolume): CutterVolume {
  const terrainApron = cloneTerrainApron(cutter.terrainApron)
  switch (cutter.kind) {
    case 'sweep':
      return {
        ...cutter,
        terrainApron,
        rings: cutter.rings.map((ring) => ({ ...ring })),
      }
    case 'capsule':
      return {
        ...cutter,
        terrainApron,
        start: { ...cutter.start },
        end: { ...cutter.end },
      }
    case 'ellipsoid':
      return {
        ...cutter,
        terrainApron,
        center: { ...cutter.center },
        radii: { ...cutter.radii },
        forward: { ...cutter.forward },
        up: cutter.up ? { ...cutter.up } : undefined,
      }
    case 'box':
      return {
        ...cutter,
        terrainApron,
        center: { ...cutter.center },
        halfExtents: { ...cutter.halfExtents },
        forward: { ...cutter.forward },
        up: cutter.up ? { ...cutter.up } : undefined,
      }
    case 'mesh':
      return {
        ...cutter,
        terrainApron,
        positions: [...cutter.positions],
        indices: [...cutter.indices],
      }
  }
}

function cloneTerrainApron(apron: TerrainApron | undefined): TerrainApron | undefined {
  if (!apron) return undefined
  return {
    ...apron,
    center: { ...apron.center },
    forward: { ...apron.forward },
  }
}

/** Segment counts. Cutter tessellation sets how clean the cut edge is. */
// Tessellation has to resolve the displacement, not just the primitive: a
// twelve-sided tube cannot carry a scallop however good the noise is.
const CAPSULE_CAP_SEGMENTS = 12
const CAPSULE_RADIAL_SEGMENTS = 36
const ELLIPSOID_WIDTH_SEGMENTS = 44
const ELLIPSOID_HEIGHT_SEGMENTS = 30
/** Box faces are subdivided so a canyon wall can be fluted rather than flat. */
const BOX_SEGMENTS = 14

/**
 * Builds the cutter as a closed world-space geometry with its transform already
 * baked in, so a set of cutters can simply be concatenated into one brush.
 */
export function cutterGeometry(
  cutter: CutterVolume,
  detail: number,
  seed: number,
): BufferGeometry {
  const geometry =
    cutter.kind === 'sweep'
      ? buildSweptCaveGeometry(cutter, detail)
      : buildLocalGeometry(cutter, detail)
  geometry.deleteAttribute('uv')
  if (cutter.kind !== 'sweep' && cutter.kind !== 'mesh') {
    geometry.applyMatrix4(cutterMatrix(cutter))
  }
  // Displaced in world space, and only after the transform is baked. Roughening
  // in the primitive's local frame would make the noise rotate and stretch with
  // the shape, and — far worse — two sections cutting the same formation would
  // disagree about the surface and leave a crack at the seam.
  if (cutter.surface !== 'none' && cutter.kind !== 'mesh') {
    const profile =
      DISPLACEMENT_PROFILES[cutter.surface ?? 'default'] ??
      DISPLACEMENT_PROFILES.default
    displaceCutterGeometry(geometry, cutter, profile, seed)
  }
  return geometry
}

function buildLocalGeometry(
  cutter: Exclude<CutterVolume, SweptCaveCutter>,
  detail: number,
): BufferGeometry {
  const scaled = (value: number) => Math.max(4, Math.round(value * detail))
  switch (cutter.kind) {
    case 'capsule': {
      const length = Math.max(0.1, distance(cutter.start, cutter.end))
      return new CapsuleGeometry(
        cutter.radius,
        length,
        scaled(CAPSULE_CAP_SEGMENTS),
        scaled(CAPSULE_RADIAL_SEGMENTS),
      )
    }
    case 'ellipsoid':
      // A unit sphere scaled by the radii: the matrix carries the shape, so the
      // same geometry serves a chamber and a thin bedding-parallel notch.
      return new SphereGeometry(
        1,
        scaled(ELLIPSOID_WIDTH_SEGMENTS),
        scaled(ELLIPSOID_HEIGHT_SEGMENTS),
      )
    case 'box':
      return new BoxGeometry(
        2,
        2,
        2,
        scaled(BOX_SEGMENTS),
        scaled(BOX_SEGMENTS),
        scaled(BOX_SEGMENTS),
      )
    case 'mesh': {
      const geometry = new BufferGeometry()
      geometry.setAttribute(
        'position',
        new BufferAttribute(Float32Array.from(cutter.positions), 3),
      )
      geometry.setIndex(new BufferAttribute(Uint32Array.from(cutter.indices), 1))
      geometry.computeVertexNormals()
      return geometry
    }
  }
}

function buildSweptCaveGeometry(
  cutter: SweptCaveCutter,
  detail: number,
): BufferGeometry {
  if (cutter.rings.length < 2) return new BufferGeometry()
  const radialSegments = Math.max(12, Math.round(32 * detail))
  const positions: number[] = []
  const indices: number[] = []
  const frames = sweepFrames(cutter.rings)

  for (let ringIndex = 0; ringIndex < cutter.rings.length; ringIndex += 1) {
    const ring = cutter.rings[ringIndex]
    const frame = frames[ringIndex]
    const pathPhase =
      (ringIndex / Math.max(1, cutter.rings.length - 1)) * Math.PI * 1.7
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = (segment / radialSegments) * Math.PI * 2
      // Low-frequency lobes make the authored cross-section itself irregular;
      // the later world-space displacement then adds rock-scale pockets. This
      // separation prevents a circular mouth even when close noise is subtle.
      const crossSectionScale =
        1 +
        Math.sin(angle * 3 + pathPhase) * 0.095 * sweepShapeNoise(cutter) +
        Math.sin(angle * 5 - pathPhase * 1.35) * 0.045 * sweepShapeNoise(cutter)
      const horizontal =
        Math.cos(angle) * ring.horizontalRadius * crossSectionScale
      const vertical =
        Math.sin(angle) * ring.verticalRadius * crossSectionScale
      positions.push(
        ring.x + frame.side.x * horizontal + frame.up.x * vertical,
        ring.y + frame.side.y * horizontal + frame.up.y * vertical,
        ring.z + frame.side.z * horizontal + frame.up.z * vertical,
      )
    }
  }

  for (let ring = 0; ring < cutter.rings.length - 1; ring += 1) {
    const current = ring * radialSegments
    const next = current + radialSegments
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const following = (segment + 1) % radialSegments
      const a = current + segment
      const b = next + segment
      const c = current + following
      const d = next + following
      indices.push(a, c, b, c, d, b)
    }
  }

  const startCenter = positions.length / 3
  const start = cutter.rings[0]
  positions.push(start.x, start.y, start.z)
  const endCenter = positions.length / 3
  const end = cutter.rings[cutter.rings.length - 1]
  positions.push(end.x, end.y, end.z)
  const endOffset = (cutter.rings.length - 1) * radialSegments
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const following = (segment + 1) % radialSegments
    indices.push(startCenter, following, segment)
    indices.push(endCenter, endOffset + segment, endOffset + following)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'position',
    new BufferAttribute(Float32Array.from(positions), 3),
  )
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

interface SweepFrame {
  side: Vec3Like
  up: Vec3Like
}

function sweepFrames(rings: readonly SweepRing[]): SweepFrame[] {
  const frames: SweepFrame[] = []
  let previousSide = new Vector3(1, 0, 0)
  for (let index = 0; index < rings.length; index += 1) {
    const before = rings[Math.max(0, index - 1)]
    const after = rings[Math.min(rings.length - 1, index + 1)]
    const tangent = new Vector3(
      after.x - before.x,
      after.y - before.y,
      after.z - before.z,
    ).normalize()
    const side = new Vector3().crossVectors(new Vector3(0, 1, 0), tangent)
    if (side.lengthSq() < 1e-8) side.copy(previousSide)
    else side.normalize()
    if (side.dot(previousSide) < 0) side.negate()
    const up = new Vector3().crossVectors(tangent, side).normalize()
    previousSide = side.clone()
    frames.push({
      side: { x: side.x, y: side.y, z: side.z },
      up: { x: up.x, y: up.y, z: up.z },
    })
  }
  return frames
}

function cutterMatrix(cutter: CutterVolume): Matrix4 {
  if (cutter.kind === 'sweep' || cutter.kind === 'mesh') return new Matrix4()
  if (cutter.kind === 'capsule') {
    // Capsule geometry is built along +y, so the rotation takes +y to the axis.
    const axis = new Vector3(
      cutter.end.x - cutter.start.x,
      cutter.end.y - cutter.start.y,
      cutter.end.z - cutter.start.z,
    )
    if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0)
    axis.normalize()
    return new Matrix4().compose(
      new Vector3(
        (cutter.start.x + cutter.end.x) * 0.5,
        (cutter.start.y + cutter.end.y) * 0.5,
        (cutter.start.z + cutter.end.z) * 0.5,
      ),
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), axis),
      new Vector3(1, 1, 1),
    )
  }

  const forward = new Vector3(
    cutter.forward.x,
    cutter.forward.y,
    cutter.forward.z,
  )
  if (forward.lengthSq() < 1e-8) forward.set(1, 0, 0)
  forward.normalize()
  const size =
    cutter.kind === 'ellipsoid' ? cutter.radii : cutter.halfExtents
  const up = new Vector3(
    cutter.up?.x ?? 0,
    cutter.up?.y ?? 1,
    cutter.up?.z ?? 0,
  ).normalize()
  const side = new Vector3().crossVectors(forward, up)
  if (side.lengthSq() < 1e-8) side.set(0, 0, 1)
  else side.normalize()
  const correctedUp = new Vector3().crossVectors(side, forward).normalize()
  const rotation = new Matrix4().makeBasis(forward, correctedUp, side)
  const quaternion = new Quaternion().setFromRotationMatrix(rotation)
  return new Matrix4().compose(
    new Vector3(cutter.center.x, cutter.center.y, cutter.center.z),
    quaternion,
    new Vector3(size.x, size.y, size.z),
  )
}

/**
 * Concatenates cutters into a single geometry.
 *
 * The components are disjoint, which a boolean handles perfectly well as long as
 * each is closed — and it means one CSG evaluation removes every volume in a
 * section instead of one evaluation per volume, each of which would otherwise
 * re-index and re-BVH the whole accumulating result.
 */
export function mergeCutterGeometries(
  geometries: BufferGeometry[],
): BufferGeometry | null {
  if (geometries.length === 0) return null

  let vertexTotal = 0
  let indexTotal = 0
  for (const geometry of geometries) {
    vertexTotal += geometry.getAttribute('position').count
    indexTotal += geometry.getIndex()?.count ?? 0
  }

  const positions = new Float32Array(vertexTotal * 3)
  const normals = new Float32Array(vertexTotal * 3)
  const indices = new Uint32Array(indexTotal)
  let vertexOffset = 0
  let indexOffset = 0

  for (const geometry of geometries) {
    const position = geometry.getAttribute('position') as BufferAttribute
    const normal = geometry.getAttribute('normal') as BufferAttribute
    const index = geometry.getIndex()
    positions.set(position.array as Float32Array, vertexOffset * 3)
    normals.set(normal.array as Float32Array, vertexOffset * 3)
    if (index) {
      for (let offset = 0; offset < index.count; offset += 1) {
        indices[indexOffset + offset] = Number(index.getX(offset)) + vertexOffset
      }
      indexOffset += index.count
    }
    vertexOffset += position.count
    geometry.dispose()
  }

  const merged = new BufferGeometry()
  merged.setAttribute('position', new BufferAttribute(positions, 3))
  merged.setAttribute('normal', new BufferAttribute(normals, 3))
  merged.setIndex(new BufferAttribute(indices, 1))
  merged.clearGroups()
  merged.addGroup(0, indices.length, 0)
  return merged
}

/**
 * World-space bounds of a cutter, used for grid densification, feature locks
 * and — critically — for deciding which sections must subtract it.
 *
 * The roughening budget is included, because the displaced surface is what
 * actually gets cut.
 */
export function cutterBounds(cutter: CutterVolume): AABB {
  const margin = cutterDisplacementBudget(cutter)
  if (cutter.kind === 'mesh') {
    if (cutter.positions.length < 3) {
      return {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 },
      }
    }
    const bounds: AABB = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    }
    for (let offset = 0; offset < cutter.positions.length; offset += 3) {
      bounds.min.x = Math.min(bounds.min.x, cutter.positions[offset])
      bounds.min.y = Math.min(bounds.min.y, cutter.positions[offset + 1])
      bounds.min.z = Math.min(bounds.min.z, cutter.positions[offset + 2])
      bounds.max.x = Math.max(bounds.max.x, cutter.positions[offset])
      bounds.max.y = Math.max(bounds.max.y, cutter.positions[offset + 1])
      bounds.max.z = Math.max(bounds.max.z, cutter.positions[offset + 2])
    }
    return bounds
  }
  if (cutter.kind === 'sweep') {
    const first = cutter.rings[0]
    if (!first) {
      return {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 },
      }
    }
    const reach = Math.max(first.horizontalRadius, first.verticalRadius) + margin
    const bounds: AABB = {
      min: { x: first.x - reach, y: first.y - reach, z: first.z - reach },
      max: { x: first.x + reach, y: first.y + reach, z: first.z + reach },
    }
    for (const ring of cutter.rings.slice(1)) {
      const ringReach =
        Math.max(ring.horizontalRadius, ring.verticalRadius) + margin
      bounds.min.x = Math.min(bounds.min.x, ring.x - ringReach)
      bounds.min.y = Math.min(bounds.min.y, ring.y - ringReach)
      bounds.min.z = Math.min(bounds.min.z, ring.z - ringReach)
      bounds.max.x = Math.max(bounds.max.x, ring.x + ringReach)
      bounds.max.y = Math.max(bounds.max.y, ring.y + ringReach)
      bounds.max.z = Math.max(bounds.max.z, ring.z + ringReach)
    }
    return bounds
  }
  if (cutter.kind === 'capsule') {
    const radius = cutter.radius + margin
    return {
      min: {
        x: Math.min(cutter.start.x, cutter.end.x) - radius,
        y: Math.min(cutter.start.y, cutter.end.y) - radius,
        z: Math.min(cutter.start.z, cutter.end.z) - radius,
      },
      max: {
        x: Math.max(cutter.start.x, cutter.end.x) + radius,
        y: Math.max(cutter.start.y, cutter.end.y) + radius,
        z: Math.max(cutter.start.z, cutter.end.z) + radius,
      },
    }
  }
  // CSG operands can pitch, yaw and roll. A spherical conservative bound keeps
  // section invalidation correct for every orientation.
  const size = cutter.kind === 'ellipsoid' ? cutter.radii : cutter.halfExtents
  const reach = Math.max(size.x, size.y, size.z) + margin
  return {
    min: {
      x: cutter.center.x - reach,
      y: cutter.center.y - reach,
      z: cutter.center.z - reach,
    },
    max: {
      x: cutter.center.x + reach,
      y: cutter.center.y + reach,
      z: cutter.center.z + reach,
    },
  }
}

/** Exterior distance from a point to an authored cutter; zero means inside. */
export function distanceToCutterVolume(
  point: Vec3Like,
  cutter: CutterVolume,
): number {
  const margin = cutterDisplacementBudget(cutter)
  if (cutter.kind === 'mesh') return distanceToAabb(point, cutterBounds(cutter))
  if (cutter.kind === 'capsule') {
    return Math.max(
      0,
      distanceToSegment(point, cutter.start, cutter.end) - cutter.radius - margin,
    )
  }
  if (cutter.kind === 'sweep') {
    if (cutter.rings.length === 0) return Infinity
    if (cutter.rings.length === 1) {
      const ring = cutter.rings[0]
      return Math.max(
        0,
        distance(point, ring) -
          Math.max(ring.horizontalRadius, ring.verticalRadius) -
          margin,
      )
    }
    let nearest = Infinity
    for (let index = 0; index < cutter.rings.length - 1; index += 1) {
      const start = cutter.rings[index]
      const end = cutter.rings[index + 1]
      const projection = segmentProjection(point, start, end)
      const radius =
        Math.max(start.horizontalRadius, start.verticalRadius) *
          (1 - projection.t) +
        Math.max(end.horizontalRadius, end.verticalRadius) * projection.t
      nearest = Math.min(nearest, projection.distance - radius - margin)
    }
    return Math.max(0, nearest)
  }

  const frame = cutterFrame(cutter.forward, cutter.up)
  const dx = point.x - cutter.center.x
  const dy = point.y - cutter.center.y
  const dz = point.z - cutter.center.z
  const localX = dx * frame.forward.x + dy * frame.forward.y + dz * frame.forward.z
  const localY = dx * frame.up.x + dy * frame.up.y + dz * frame.up.z
  const localZ = dx * frame.side.x + dy * frame.side.y + dz * frame.side.z
  const size = cutter.kind === 'ellipsoid' ? cutter.radii : cutter.halfExtents
  if (cutter.kind === 'box') {
    return Math.max(
      0,
      Math.hypot(
        Math.max(0, Math.abs(localX) - size.x - margin),
        Math.max(0, Math.abs(localY) - size.y - margin),
        Math.max(0, Math.abs(localZ) - size.z - margin),
      ),
    )
  }
  const normalizedDistance = Math.hypot(
    localX / Math.max(1e-6, size.x + margin),
    localY / Math.max(1e-6, size.y + margin),
    localZ / Math.max(1e-6, size.z + margin),
  )
  return Math.max(0, normalizedDistance - 1) * Math.min(size.x, size.y, size.z)
}

/** Union of several bounds; returns null for an empty list. */
export function unionBounds(all: readonly AABB[]): AABB | null {
  if (all.length === 0) return null
  const union: AABB = {
    min: { ...all[0].min },
    max: { ...all[0].max },
  }
  for (const bounds of all.slice(1)) {
    union.min.x = Math.min(union.min.x, bounds.min.x)
    union.min.y = Math.min(union.min.y, bounds.min.y)
    union.min.z = Math.min(union.min.z, bounds.min.z)
    union.max.x = Math.max(union.max.x, bounds.max.x)
    union.max.y = Math.max(union.max.y, bounds.max.y)
    union.max.z = Math.max(union.max.z, bounds.max.z)
  }
  return union
}

function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
}

function sweepShapeNoise(cutter: SweptCaveCutter): number {
  return Math.max(0, Math.min(1.75, cutter.noise ?? 1))
}

function distanceToSegment(
  point: Vec3Like,
  start: Vec3Like,
  end: Vec3Like,
): number {
  return segmentProjection(point, start, end).distance
}

function segmentProjection(
  point: Vec3Like,
  start: Vec3Like,
  end: Vec3Like,
): { distance: number; t: number } {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const dz = end.z - start.z
  const lengthSquared = dx * dx + dy * dy + dz * dz
  const t = lengthSquared > 1e-8
    ? Math.max(
        0,
        Math.min(
          1,
          ((point.x - start.x) * dx +
            (point.y - start.y) * dy +
            (point.z - start.z) * dz) /
            lengthSquared,
        ),
      )
    : 0
  const nearest = {
    x: start.x + dx * t,
    y: start.y + dy * t,
    z: start.z + dz * t,
  }
  return { distance: distance(point, nearest), t }
}

function cutterFrame(
  forwardValue: Vec3Like,
  upValue: Vec3Like | undefined,
): { forward: Vec3Like; up: Vec3Like; side: Vec3Like } {
  const forward = normalizeVector(forwardValue, { x: 1, y: 0, z: 0 })
  const requestedUp = normalizeVector(upValue ?? { x: 0, y: 1, z: 0 }, {
    x: 0,
    y: 1,
    z: 0,
  })
  let side = cross(forward, requestedUp)
  if (Math.hypot(side.x, side.y, side.z) < 1e-6) side = { x: 0, y: 0, z: 1 }
  side = normalizeVector(side, { x: 0, y: 0, z: 1 })
  return { forward, side, up: normalizeVector(cross(side, forward), requestedUp) }
}

function cross(a: Vec3Like, b: Vec3Like): Vec3Like {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function normalizeVector(value: Vec3Like, fallback: Vec3Like): Vec3Like {
  const length = Math.hypot(value.x, value.y, value.z)
  return length > 1e-8
    ? { x: value.x / length, y: value.y / length, z: value.z / length }
    : { ...fallback }
}
