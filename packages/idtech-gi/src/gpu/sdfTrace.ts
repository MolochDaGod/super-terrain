import { Vector3 } from 'three/webgpu'
import type { Node } from './nodes.ts'
import {
  Break,
  If,
  Loop,
  float,
  max,
  min,
  normalize,
  select,
  texture3D,
  uniform,
  vec3,
  vec4,
} from './nodes.ts'
import type { VoxelScene } from './voxelScene.ts'


export interface SdfBinding {
  /** vec3 uniform: min corner of the volume. */
  origin: Node
  /** vec3 uniform: world size of the volume. */
  extent: Node
  invExtent: Node
  /** float uniform: world size of one voxel. */
  cell: Node
  scene: VoxelScene
}

export interface RayHit {
  /** 1 when the ray terminated on a surface. */
  hit: Node
  /** World position of the hit (undefined content on a miss). */
  position: Node
  /** Distance travelled; equals `tMax` on a miss. */
  distance: Node
  /** Outward surface normal from the SDF gradient. */
  normal: Node
  /** Linear albedo at the hit. */
  albedo: Node
}

export function createSdfBinding(scene: VoxelScene): SdfBinding {
  return {
    origin: uniform(scene.origin.clone()) as Node,
    extent: uniform(scene.extent.clone()) as Node,
    invExtent: uniform(
      new Vector3(1 / scene.extent.x, 1 / scene.extent.y, 1 / scene.extent.z),
    ) as Node,
    cell: uniform(scene.cell) as Node,
    scene,
  }
}

/** World position → volume texture coordinate. Texel centres line up with voxel centres. */
export function toUvw(sdf: SdfBinding, p: Node): Node {
  return p.sub(sdf.origin).mul(sdf.invExtent)
}

/**
 * Unsigned distance to the nearest surface, in world units.
 *
 * The explicit mip level is not an optimisation. In a fragment shader an
 * implicit-LOD sample inside a loop with data-dependent breaks is a WGSL
 * uniformity violation, and the pipeline fails to build — which shows up as a
 * silently black surface, not as an error. Compute shaders get level 0 anyway.
 */
export function sampleDistance(sdf: SdfBinding, p: Node): Node {
  return texture3D(sdf.scene.sdf, toUvw(sdf, p).clamp(0, 1)).level(0).r
}

/**
 * Linear albedo at a surface point.
 *
 * The volume only stores colour in covered voxels, so a trilinear tap near a
 * surface mixes the wall's albedo with empty neighbours and comes back far too
 * dark. Coverage lives in alpha and is filtered by the same weights, so
 * dividing by it recovers the coverage-weighted average — the difference
 * between a bounce that reads as sunlight and one that reads as dirt.
 */
export function sampleAlbedo(sdf: SdfBinding, p: Node, normal?: Node): Node {
  const probe = normal ? p.sub(normal.mul(sdf.cell.mul(0.75))) : p
  const texel = texture3D(sdf.scene.albedo, toUvw(sdf, probe).clamp(0, 1)).level(0)
  return texel.rgb.div(max(texel.a, float(0.02))).clamp(0, 1)
}

/**
 * Central-difference gradient of the distance field. Because the field is
 * unsigned, this always points away from the surface — which is the outward
 * normal for any ray arriving from open space, on both sides of a thin wall.
 */
export function sampleGradient(sdf: SdfBinding, p: Node): Node {
  const h = sdf.cell.mul(0.85)
  const dx = sampleDistance(sdf, p.add(vec3(h, 0, 0))).sub(
    sampleDistance(sdf, p.sub(vec3(h, 0, 0))),
  )
  const dy = sampleDistance(sdf, p.add(vec3(0, h, 0))).sub(
    sampleDistance(sdf, p.sub(vec3(0, h, 0))),
  )
  const dz = sampleDistance(sdf, p.add(vec3(0, 0, h))).sub(
    sampleDistance(sdf, p.sub(vec3(0, 0, h))),
  )
  return vec3(dx, dy, dz)
}

/** Entry/exit parameters of the ray against the volume bounds, as `vec2(tNear, tFar)`. */
function slabs(sdf: SdfBinding, origin: Node, dir: Node): { near: Node; far: Node } {
  const sign = select(dir.lessThan(0), vec3(-1, -1, -1), vec3(1, 1, 1))
  const safe = sign.mul(max(dir.abs(), float(1e-6)))
  const inv = vec3(1, 1, 1).div(safe)
  const t0 = sdf.origin.sub(origin).mul(inv)
  const t1 = sdf.origin.add(sdf.extent).sub(origin).mul(inv)
  const lo = min(t0, t1)
  const hi = max(t0, t1)
  return {
    near: max(max(lo.x, lo.y), lo.z),
    far: min(min(hi.x, hi.y), hi.z),
  }
}

export interface TraceOptions {
  maxSteps?: number
  /** Hit threshold as a fraction of a voxel. */
  epsilon?: number
  /** Distance to skip before the first sample, to escape the origin surface. */
  startOffset?: Node | number
}

/**
 * Sphere trace. The step length is the distance field itself, so empty space is
 * crossed in a few taps and the hit point is a continuous function of the ray —
 * no step-phase jitter, which is what made the previous fixed-step march crawl.
 */
export function traceSdf(
  sdf: SdfBinding,
  origin: Node,
  dir: Node,
  tMax: Node,
  options: TraceOptions = {},
): RayHit {
  const maxSteps = options.maxSteps ?? 64
  const epsilon = sdf.cell.mul(options.epsilon ?? 0.4)
  const bounds = slabs(sdf, origin, dir)
  const start = max(
    max(bounds.near, float(0)).add(float(options.startOffset ?? 0)),
    float(0),
  )
  const limit = min(bounds.far, tMax)

  const t = start.toVar()
  const hit = float(0).toVar()
  Loop({ start: 0, end: maxSteps, type: 'int' }, () => {
    If(t.greaterThan(limit), () => {
      Break()
    })
    const p = origin.add(dir.mul(t))
    const d = sampleDistance(sdf, p)
    If(d.lessThan(epsilon), () => {
      hit.assign(1)
      Break()
    })
    // A floor under the step keeps grazing rays from stalling near a surface.
    t.addAssign(max(d, sdf.cell.mul(0.35)))
  })

  // Materialised once: the gradient alone is six volume taps and both the
  // shading and the bounce lookup want the same values.
  const position = origin.add(dir.mul(t)).toVar()
  const grad = sampleGradient(sdf, position)
  const gradLen = grad.length()
  const normal = normalize(
    select(
      gradLen.greaterThan(float(1e-5)),
      grad.div(max(gradLen, float(1e-5))),
      dir.negate(),
    ),
  ).toVar()
  return {
    hit,
    position,
    distance: t,
    normal,
    albedo: sampleAlbedo(sdf, position, normal).toVar(),
  }
}

/**
 * Visibility only. Returns 1 when nothing blocks the segment. Cheaper than
 * `traceSdf` because it skips the gradient and albedo fetches.
 */
export function traceShadow(
  sdf: SdfBinding,
  origin: Node,
  dir: Node,
  tMax: Node,
  maxSteps = 40,
): Node {
  const bounds = slabs(sdf, origin, dir)
  const limit = min(bounds.far, tMax)
  const t = max(bounds.near, sdf.cell.mul(1.0)).toVar()
  const visible = float(1).toVar()
  Loop({ start: 0, end: maxSteps, type: 'int' }, () => {
    If(t.greaterThan(limit), () => {
      Break()
    })
    const d = sampleDistance(sdf, origin.add(dir.mul(t)))
    If(d.lessThan(sdf.cell.mul(0.4)), () => {
      visible.assign(0)
      Break()
    })
    t.addAssign(max(d, sdf.cell.mul(0.35)))
  })
  return visible
}

/**
 * Soft shadow via the classic sphere-trace penumbra estimator. The closest
 * approach of the ray to any occluder stands in for the blocker search, which
 * an SDF gives away for free.
 */
export function traceSoftShadow(
  sdf: SdfBinding,
  origin: Node,
  dir: Node,
  tMax: Node,
  softness: number,
  maxSteps = 40,
): Node {
  const bounds = slabs(sdf, origin, dir)
  const limit = min(bounds.far, tMax)
  const t = max(bounds.near, sdf.cell.mul(1.25)).toVar()
  const result = float(1).toVar()
  Loop({ start: 0, end: maxSteps, type: 'int' }, () => {
    If(t.greaterThan(limit), () => {
      Break()
    })
    const d = sampleDistance(sdf, origin.add(dir.mul(t)))
    If(d.lessThan(sdf.cell.mul(0.35)), () => {
      result.assign(0)
      Break()
    })
    result.assign(min(result, d.mul(softness).div(t)))
    t.addAssign(max(d, sdf.cell.mul(0.35)))
  })
  return result.clamp(0, 1)
}

/** Packs a hit into a vec4 for storage buffers: xyz radiance, w distance. */
export function packRadiance(radiance: Node, distance: Node): Node {
  return vec4(radiance, distance)
}
