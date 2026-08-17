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

interface CutterBase {
  /**
   * Which displacement character to roughen this volume with. A cut left
   * analytic reads as machined, so this is effectively required for anything
   * meant to look like rock.
   */
  surface?: keyof typeof DISPLACEMENT_PROFILES
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
}

/** A rotated box, used for the straight-walled reaches of a slot canyon. */
export interface BoxCutter extends CutterBase {
  kind: 'box'
  center: Vec3Like
  halfExtents: Vec3Like
  forward: Vec3Like
}

export function cloneCutterVolume(cutter: CutterVolume): CutterVolume {
  switch (cutter.kind) {
    case 'sweep':
      return { ...cutter, rings: cutter.rings.map((ring) => ({ ...ring })) }
    case 'capsule':
      return { ...cutter, start: { ...cutter.start }, end: { ...cutter.end } }
    case 'ellipsoid':
      return {
        ...cutter,
        center: { ...cutter.center },
        radii: { ...cutter.radii },
        forward: { ...cutter.forward },
      }
    case 'box':
      return {
        ...cutter,
        center: { ...cutter.center },
        halfExtents: { ...cutter.halfExtents },
        forward: { ...cutter.forward },
      }
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
  if (cutter.kind !== 'sweep') geometry.applyMatrix4(cutterMatrix(cutter))
  // Displaced in world space, and only after the transform is baked. Roughening
  // in the primitive's local frame would make the noise rotate and stretch with
  // the shape, and — far worse — two sections cutting the same formation would
  // disagree about the surface and leave a crack at the seam.
  const profile =
    DISPLACEMENT_PROFILES[cutter.surface ?? 'default'] ??
    DISPLACEMENT_PROFILES.default
  displaceCutterGeometry(geometry, cutter, profile, seed)
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
        Math.sin(angle * 3 + pathPhase) * 0.095 +
        Math.sin(angle * 5 - pathPhase * 1.35) * 0.045
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
  if (cutter.kind === 'sweep') return new Matrix4()
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
  return new Matrix4().compose(
    new Vector3(cutter.center.x, cutter.center.y, cutter.center.z),
    new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), forward),
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
  // Rotation is about Y only in practice, but the conservative bound is the
  // largest half-extent applied on every axis, which costs nothing here.
  const size = cutter.kind === 'ellipsoid' ? cutter.radii : cutter.halfExtents
  const reach = Math.max(size.x, size.z) + margin
  return {
    min: {
      x: cutter.center.x - reach,
      y: cutter.center.y - size.y - margin,
      z: cutter.center.z - reach,
    },
    max: {
      x: cutter.center.x + reach,
      y: cutter.center.y + size.y + margin,
      z: cutter.center.z + reach,
    },
  }
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
