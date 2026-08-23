import { clamp, smoothstep } from '../core/bounds'
import type { BrushDomain, BrushMode } from './types'

/**
 * The one place a sculpt dab is defined.
 *
 * Both the authoritative field evaluation and the live viewport preview call
 * into this module, so what a stroke looks like while it is being drawn is by
 * construction what the worker compiles afterwards. The two used to carry
 * separate copies of the maths and drifted -- `smooth` in particular meant two
 * different operations depending on which side you looked at.
 */

/**
 * Depth reached by one full-strength pass, as a fraction of brush radius.
 *
 * Deposition is deliberately tied to the brush footprint. A fixed metre amount
 * makes a wide brush feel inert on terrain-sized geometry and a narrow one feel
 * explosive; scaling with radius keeps the gesture proportional to the mass the
 * user is visibly targeting.
 */
export const BRUSH_DEPTH_PER_RADIUS = 0.4

/**
 * Hard ceiling on what one stroke may move a point, as a fraction of radius.
 *
 * The modes converge on their own, well inside this; the clamp exists so that
 * no combination of dabs, normals and held flow can ever stretch the surface
 * further than the brush footprint can smoothly absorb. Displacement tapers to
 * zero across the radius, so bounding it here also bounds the slope the stroke
 * can introduce, which is what keeps the grid from folding over itself.
 */
export const MAX_STROKE_DISPLACEMENT_PER_RADIUS = 0.9

/**
 * Ceilings on sideways travel, as fractions of radius.
 *
 * Sideways displacement is the point of mesh-domain sculpting -- it is what
 * pushes a face out into the third dimension instead of only up and down. It is
 * also what can turn a section's triangles inside out, because a section is
 * triangulated over its XZ footprint and a vertex that outruns its neighbours
 * inverts them. The two are not equally risky, and measurement shows why:
 * displacement along the outward normal spreads vertices apart, which stays
 * well-conditioned, while displacement inward draws them together and folds at
 * roughly a third of the travel. So the budget is directional -- generous for
 * building out, conservative for cutting in -- rather than one flat number that
 * would have to be set to the tighter of the two.
 *
 * Beyond these, a surface that genuinely doubles back over itself needs
 * topology the XZ grid cannot express; that is what the CSG volumes are for.
 */
export const MAX_OUTWARD_SLIDE_PER_RADIUS = 0.45
export const MAX_INWARD_SLIDE_PER_RADIUS = 0.45

/**
 * How hard one pinch dab exaggerates relief, as a fraction of brush depth.
 *
 * Sharpening steepens slopes by construction, and in mesh domain a steeper
 * slope tilts the sample normal further from vertical, so displacement along it
 * carries more sideways travel. Keeping the per-dab step modest is what lets
 * many passes over one spot stay inside the tangential budget.
 */
const PINCH_SHARPEN_PER_REACH = 0.3

/** Noise depth as a fraction of its own wavelength. Above ~0.5 it folds. */
const NOISE_AMPLITUDE_PER_WAVELENGTH = 0.45

export interface BrushKernelParams {
  mode: BrushMode
  domain: BrushDomain
  radius: number
  strength: number
  falloff: number
  targetY?: number
  terraceStep?: number
  noiseScale?: number
  noiseSeed?: number
  /**
   * Whether one stroke may keep building for as long as it is held.
   *
   * Off, a stroke converges on a depth set by the brush profile and stops, so
   * releasing and pressing again is how you build further. That keeps a held
   * brush from driving the surface past what its footprint can taper back down.
   * On, dabs simply add up, which is the freer feel but will eventually deform
   * the surface further than its triangulation can follow.
   */
  accumulate?: boolean
}

/** A dab with its normal pre-normalized, so the hot loop never renormalizes. */
export interface BrushKernelSample {
  x: number
  y: number
  z: number
  normalX: number
  normalY: number
  normalZ: number
  weight: number
}

export interface MutablePoint {
  x: number
  y: number
  z: number
}

/**
 * Radial brush profile in [0, 1].
 *
 * `falloff` reads as softness: 0 is a near-flat disc that moves its whole
 * footprint by the same amount, 1 is a dome that tapers from the centre out.
 */
export function brushProfile(
  distance: number,
  radius: number,
  falloff: number,
): number {
  if (distance >= radius) return 0
  const core = radius * (1 - clamp(falloff, 0, 1)) * 0.9
  if (distance <= core) return 1
  return 1 - smoothstep(core, radius, distance)
}

/** Largest displacement a single dab of these params can produce. */
export function maximumDabDisplacement(params: BrushKernelParams): number {
  return params.radius * BRUSH_DEPTH_PER_RADIUS
}

/**
 * Displaces `point` by one dab, in place.
 *
 * Dabs are applied in authored order and each sees the point as the previous
 * ones left it, which is what makes held strokes accumulate.
 */
export function applyBrushDab(
  point: MutablePoint,
  params: BrushKernelParams,
  sample: BrushKernelSample,
  anchor: Readonly<MutablePoint>,
): void {
  const isHeightfield = params.domain === 'heightfield'
  const dx = point.x - sample.x
  const dy = point.y - sample.y
  const dz = point.z - sample.z
  const distance = isHeightfield
    ? Math.hypot(dx, dz)
    : Math.hypot(dx, dy, dz)
  if (distance >= params.radius) return

  const radial = brushProfile(distance, params.radius, params.falloff)
  if (radial <= 0) return
  // Two separate things. `flow` is how fast this dab moves a point toward what
  // the stroke is shaping; `radial` is how deep that shape goes here. Folding
  // them into one number made the profile govern only the rate, so every point
  // in the footprint eventually converged on the same depth and the surface
  // saturated into a flat slab with a hard shoulder at the rim.
  const flow = clamp(params.strength, 0, 1) * Math.max(0, sample.weight)
  if (flow <= 0) return
  const weight = radial * flow

  const nx = sample.normalX
  const ny = sample.normalY
  const nz = sample.normalZ
  const reach = params.radius * BRUSH_DEPTH_PER_RADIUS
  // Signed height of this point above the plane the dab was laid down on.
  const planeDistance = isHeightfield
    ? point.y - sample.y
    : dx * nx + dy * ny + dz * nz
  // How far this stroke has already moved the point along the dab normal.
  //
  // The building modes converge against this rather than against the dab plane.
  // The editor raycasts each dab against the previewed geometry, so a held
  // brush reports planes that climb the mound it is raising; measuring room
  // from the plane let every pixel of pointer jitter reopen a full allowance,
  // which is the grow-stop-grow ratchet and, after enough of it, deformation
  // far past what the footprint can taper back down. The anchor is the point's
  // own position before the stroke touched it and cannot drift.
  const travelled =
    (point.x - anchor.x) * nx +
    (point.y - anchor.y) * ny +
    (point.z - anchor.z) * nz

  switch (params.mode) {
    case 'raise':
    case 'lower': {
      // Deposition converges on a target depth rather than integrating without
      // limit. Holding the pointer used to run to roughly a full brush radius
      // in about two seconds, which spikes the surface far past what the
      // footprint can taper back down and is what tore the mesh open. One
      // stroke now settles at its target; pressing again anchors a new one to
      // the surface it just made, so repeated passes still build without bound.
      const sign = params.mode === 'raise' ? 1 : -1
      if (params.accumulate) {
        displace(point, nx, ny, nz, weight * reach * sign)
        break
      }
      const room = Math.max(0, reach * radial - travelled * sign)
      displace(point, nx, ny, nz, room * clamp(flow, 0, 1) * sign)
      break
    }
    case 'clay': {
      // Clay strips build mass toward a crest a fixed height above the dab
      // plane, so holding still thickens the slab instead of drilling a spike.
      // Clay keeps a broad flat crest by design -- that is what separates it
      // from raise -- but the shoulder still has to come down to meet the
      // surface, so the target is a widened profile rather than a constant.
      const crest = Math.min(1, radial * 1.7)
      if (params.accumulate) {
        displace(point, nx, ny, nz, weight * reach * crest)
        break
      }
      const room = Math.max(0, reach * crest - travelled)
      displace(point, nx, ny, nz, room * clamp(flow * 1.8, 0, 1))
      break
    }
    case 'flatten': {
      const target = isHeightfield
        ? point.y - (params.targetY ?? sample.y)
        : planeDistance
      displace(point, nx, ny, nz, -target * clamp(weight, 0, 1))
      break
    }
    case 'smooth': {
      // Relaxing toward the surface the stroke itself sampled: local bumps
      // sink and pits fill, while the broad shape the user drew survives.
      displace(point, nx, ny, nz, -planeDistance * clamp(weight * 0.75, 0, 1))
      break
    }
    case 'pinch': {
      // Sharpening by exaggerating relief about the dab plane: what already
      // stands proud rises, what is already cut sinks, and the crossing point
      // stays put. The old pinch slid vertices sideways toward the dab centre,
      // which is how a ridge gets sharpened on a mesh you can retopologize --
      // but terrain sections are triangulated over their XZ footprint, so
      // enough passes dragged vertices past their neighbours and turned the
      // surface inside out. Working along the normal reaches the same result
      // and cannot fold the grid.
      // The ramp is continuous through the plane. A hard sign would push two
      // vertices straddling the crossing in opposite directions along a tilted
      // normal, which is a fold in miniature repeated all along the contour.
      const relief = clamp(planeDistance / reach, -1, 1)
      const room =
        relief * reach * PINCH_SHARPEN_PER_REACH * radial - travelled
      displace(point, nx, ny, nz, room * clamp(flow, 0, 1))
      break
    }
    case 'scrape': {
      const above = isHeightfield
        ? point.y - (params.targetY ?? sample.y)
        : planeDistance
      if (above <= 0) break
      displace(point, nx, ny, nz, -above * clamp(weight, 0, 1))
      break
    }
    case 'terrace': {
      const step = Math.max(0.25, params.terraceStep ?? 4)
      const target = Math.round(point.y / step) * step
      point.y += (target - point.y) * clamp(weight, 0, 1)
      break
    }
    case 'noise': {
      const scale = Math.max(0.15, params.noiseScale ?? 3)
      const noise = smoothValueNoise3(
        point.x / scale,
        point.y / scale,
        point.z / scale,
        params.noiseSeed ?? 1,
      ) * 2 - 1
      // Amplitude is tied to the noise's own wavelength, not to the brush.
      // Breakup a few metres across cannot be several metres deep without the
      // surface between two neighbouring vertices turning over, and the old
      // per-cell hash made that worse by stepping rather than blending.
      const amplitude = Math.min(reach, scale * NOISE_AMPLITUDE_PER_WAVELENGTH)
      const room = noise * amplitude * radial - travelled
      displace(point, nx, ny, nz, room * clamp(flow, 0, 1))
      break
    }
  }

  limitDisplacement(
    point,
    anchor,
    params.radius,
    nx,
    ny,
    nz,
    params.accumulate === true,
  )
}

/**
 * Holds a point inside what its neighbourhood can follow.
 *
 * Applied after every dab against the position the point held before this
 * stroke touched it, so the bound is on the stroke as a whole and cannot be
 * walked past by adding more dabs.
 */
function limitDisplacement(
  point: MutablePoint,
  anchor: Readonly<MutablePoint>,
  radius: number,
  nx: number,
  ny: number,
  nz: number,
  accumulate: boolean,
): void {
  let dx = point.x - anchor.x
  let dy = point.y - anchor.y
  let dz = point.z - anchor.z

  const outward = dx * nx + dy * ny + dz * nz >= 0
  const tangentialLimit =
    radius *
    (outward ? MAX_OUTWARD_SLIDE_PER_RADIUS : MAX_INWARD_SLIDE_PER_RADIUS)
  const tangential = Math.hypot(dx, dz)
  if (tangential > tangentialLimit) {
    const scale = tangentialLimit / tangential
    dx *= scale
    dz *= scale
  }

  // Sideways travel is bounded even when accumulating: it is what inverts
  // triangles, and no amount of opting in makes a torn section useful. Growth
  // along the normal is the part that is set free -- pushing a heightfield
  // straight up cannot fold its own triangulation however far it goes.
  if (accumulate) {
    point.x = anchor.x + dx
    point.y = anchor.y + dy
    point.z = anchor.z + dz
    return
  }

  const totalLimit = radius * MAX_STROKE_DISPLACEMENT_PER_RADIUS
  const total = Math.hypot(dx, dy, dz)
  if (total > totalLimit) {
    const scale = totalLimit / total
    dx *= scale
    dy *= scale
    dz *= scale
  }

  point.x = anchor.x + dx
  point.y = anchor.y + dy
  point.z = anchor.z + dz
}

function displace(
  point: MutablePoint,
  nx: number,
  ny: number,
  nz: number,
  distance: number,
): void {
  point.x += nx * distance
  point.y += ny * distance
  point.z += nz * distance
}

/** Trilinearly blended value noise, so a dab breaks the surface up smoothly. */
function smoothValueNoise3(
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const z0 = Math.floor(z)
  const tx = smoothstep(0, 1, x - x0)
  const ty = smoothstep(0, 1, y - y0)
  const tz = smoothstep(0, 1, z - z0)
  const c000 = brushHash3(x0, y0, z0, seed)
  const c100 = brushHash3(x0 + 1, y0, z0, seed)
  const c010 = brushHash3(x0, y0 + 1, z0, seed)
  const c110 = brushHash3(x0 + 1, y0 + 1, z0, seed)
  const c001 = brushHash3(x0, y0, z0 + 1, seed)
  const c101 = brushHash3(x0 + 1, y0, z0 + 1, seed)
  const c011 = brushHash3(x0, y0 + 1, z0 + 1, seed)
  const c111 = brushHash3(x0 + 1, y0 + 1, z0 + 1, seed)
  const x00 = c000 + (c100 - c000) * tx
  const x10 = c010 + (c110 - c010) * tx
  const x01 = c001 + (c101 - c001) * tx
  const x11 = c011 + (c111 - c011) * tx
  const y0z0 = x00 + (x10 - x00) * ty
  const y1z1 = x01 + (x11 - x01) * ty
  return y0z0 + (y1z1 - y0z0) * tz
}

export function brushHash3(
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  let value =
    Math.imul(x, 374_761_393) ^
    Math.imul(y, 668_265_263) ^
    Math.imul(z, 2_147_483_647) ^
    seed
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177)
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295
}
