import { boundsFromSphere, unionBounds } from '../core/bounds'
import type { AABB, Vec3Like } from '../core/types'
import type {
  BooleanSubtractModifier,
  TunnelPortal,
} from './types'

export type TunnelPath = readonly [Vec3Like, Vec3Like, Vec3Like, Vec3Like]

interface LegacyTunnelShape {
  center?: Vec3Like
  direction?: { x: number; z: number }
  length?: number
  surfaceY?: number
  portals?: [TunnelPortal, TunnelPortal]
  depth?: number
  shape?: 'capsule-path'
}

/**
 * Normalizes both current portal-authored tunnels and v1-v3 fixed A→B tunnel
 * stamps. Keeping migration here prevents persistence, workers, and rendering
 * from each inventing their own compatibility rules.
 */
export function normalizeTunnelModifier(
  modifier: BooleanSubtractModifier,
): BooleanSubtractModifier {
  const legacy = modifier as BooleanSubtractModifier & LegacyTunnelShape
  const radius = Math.max(0.25, Number.isFinite(modifier.radius) ? modifier.radius : 8)
  const portals: [TunnelPortal, TunnelPortal] = legacy.portals
    ? [clonePortal(legacy.portals[0]), clonePortal(legacy.portals[1])]
    : portalsFromLegacy(legacy, radius)
  const normalized: BooleanSubtractModifier = {
    ...modifier,
    shape: 'capsule-path',
    portals,
    radius,
    depth: Math.max(
      radius * 0.35,
      legacy.depth ?? legacyDepth(legacy, radius),
    ),
    backend: modifier.backend ?? 'bvh-csg-tunnel-v3',
  }
  normalized.bounds = tunnelBounds(normalized)
  return normalized
}

export function updateTunnelPortal(
  modifier: BooleanSubtractModifier,
  index: 0 | 1,
  point: Vec3Like,
  normal: Vec3Like,
): void {
  modifier.portals[index] = {
    ...point,
    normal: normalize3(normal),
  }
  modifier.bounds = tunnelBounds(modifier)
}

export function tunnelPortalDistance(modifier: BooleanSubtractModifier): number {
  const [start, end] = modifier.portals
  return Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z)
}

/** The actual swept Boolean centerline, including both surface entrances. */
export function tunnelPathPoints(modifier: BooleanSubtractModifier): TunnelPath {
  const [start, end] = modifier.portals
  const startNormal = normalize3(start.normal)
  const endNormal = normalize3(end.normal)
  const mouthOffset = modifier.radius * 0.22
  return [
    addScaled(start, startNormal, mouthOffset),
    addScaled(start, startNormal, -modifier.depth),
    addScaled(end, endNormal, -modifier.depth),
    addScaled(end, endNormal, mouthOffset),
  ]
}

export function tunnelBounds(modifier: BooleanSubtractModifier): AABB {
  const path = tunnelPathPoints(modifier)
  const halo = modifier.radius * 1.08
  let bounds = boundsFromSphere(path[0], halo)
  for (let index = 1; index < path.length; index += 1) {
    bounds = unionBounds(bounds, boundsFromSphere(path[index], halo))
  }
  return bounds
}

export function createTunnelPortals(options: {
  start?: TunnelPortal
  end?: TunnelPortal
  center?: Vec3Like
  length?: number
  direction?: { x: number; z: number }
}): [TunnelPortal, TunnelPortal] {
  if (options.start) {
    return [
      clonePortal(options.start),
      clonePortal(options.end ?? options.start),
    ]
  }
  const center = options.center ?? { x: 0, y: 0, z: 0 }
  const direction = normalizePlanar(options.direction ?? { x: 1, z: 0 })
  const halfLength = Math.max(0, options.length ?? 58) * 0.5
  return [
    {
      x: center.x - direction.x * halfLength,
      y: center.y,
      z: center.z - direction.z * halfLength,
      normal: { x: 0, y: 1, z: 0 },
    },
    {
      x: center.x + direction.x * halfLength,
      y: center.y,
      z: center.z + direction.z * halfLength,
      normal: { x: 0, y: 1, z: 0 },
    },
  ]
}

function portalsFromLegacy(
  legacy: LegacyTunnelShape,
  radius: number,
): [TunnelPortal, TunnelPortal] {
  const center = legacy.center ?? { x: 0, y: 0, z: 0 }
  const direction = normalizePlanar(legacy.direction ?? { x: 1, z: 0 })
  const halfLength = Math.max(radius * 0.5, legacy.length ?? 58) * 0.5
  const surfaceY = legacy.surfaceY ?? center.y + radius * 1.75
  return [
    {
      x: center.x - direction.x * halfLength,
      y: surfaceY,
      z: center.z - direction.z * halfLength,
      normal: { x: 0, y: 1, z: 0 },
    },
    {
      x: center.x + direction.x * halfLength,
      y: surfaceY,
      z: center.z + direction.z * halfLength,
      normal: { x: 0, y: 1, z: 0 },
    },
  ]
}

function legacyDepth(legacy: LegacyTunnelShape, radius: number): number {
  if (!legacy.center) return radius * 1.75
  return Math.max(
    radius * 1.1,
    (legacy.surfaceY ?? legacy.center.y + radius * 1.75) - legacy.center.y,
  )
}

function clonePortal(portal: TunnelPortal): TunnelPortal {
  return {
    x: portal.x,
    y: portal.y,
    z: portal.z,
    normal: normalize3(portal.normal ?? { x: 0, y: 1, z: 0 }),
  }
}

function addScaled(point: Vec3Like, direction: Vec3Like, scale: number): Vec3Like {
  return {
    x: point.x + direction.x * scale,
    y: point.y + direction.y * scale,
    z: point.z + direction.z * scale,
  }
}

function normalizePlanar(value: { x: number; z: number }): { x: number; z: number } {
  const length = Math.hypot(value.x, value.z) || 1
  return { x: value.x / length, z: value.z / length }
}

export function normalize3(value: Vec3Like): Vec3Like {
  const length = Math.hypot(value.x, value.y, value.z) || 1
  return { x: value.x / length, y: value.y / length, z: value.z / length }
}
