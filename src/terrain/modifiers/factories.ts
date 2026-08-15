import { boundsFromSphere, unionBounds } from '../core/bounds'
import type { AABB, Vec3Like } from '../core/types'
import type {
  BooleanSubtractModifier,
  BrushMode,
  BrushStrokeModifier,
  NoiseModifier,
  RemeshModifier,
  TessellateModifier,
} from './types'

let fallbackId = 0

export function createModifierId(prefix: string): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${fallbackId++}`
  return `${prefix}-${suffix}`
}

export function createBrushStroke(options: {
  point: Vec3Like
  mode: BrushMode
  radius: number
  strength: number
  falloff: number
  targetY?: number
}): BrushStrokeModifier {
  return {
    id: createModifierId('stroke'),
    type: 'brush-stroke',
    enabled: true,
    priority: 100,
    bounds: boundsFromSphere(options.point, options.radius),
    mode: options.mode,
    radius: options.radius,
    strength: options.strength,
    falloff: options.falloff,
    targetY: options.targetY,
    points: [{ ...options.point }],
  }
}

export function appendBrushPoint(
  modifier: BrushStrokeModifier,
  point: Vec3Like,
): AABB {
  modifier.points.push({ ...point })
  const pointBounds = boundsFromSphere(point, modifier.radius)
  modifier.bounds = unionBounds(modifier.bounds, pointBounds)
  return pointBounds
}

export function createRemeshModifier(options: {
  center: Vec3Like
  radius: number
  targetEdgeLength: number
}): RemeshModifier {
  return {
    id: createModifierId('remesh'),
    type: 'remesh',
    enabled: true,
    priority: 80,
    bounds: boundsFromSphere(options.center, options.radius),
    center: { ...options.center },
    radius: options.radius,
    targetEdgeLength: options.targetEdgeLength,
    minEdgeLength: options.targetEdgeLength * 0.45,
    maxEdgeLength: options.targetEdgeLength * 2.25,
    iterations: 3,
  }
}

export function createTessellateModifier(options: {
  center: Vec3Like
  radius: number
  targetEdgeLength: number
}): TessellateModifier {
  return {
    id: createModifierId('tessellate'),
    type: 'tessellate',
    enabled: true,
    priority: 75,
    bounds: boundsFromSphere(options.center, options.radius),
    center: { ...options.center },
    radius: options.radius,
    targetEdgeLength: options.targetEdgeLength,
  }
}

export function createTunnelModifier(options: {
  center: Vec3Like
  radius?: number
  length?: number
  direction?: { x: number; z: number }
}): BooleanSubtractModifier {
  const radius = options.radius ?? 8
  const length = options.length ?? 58
  const direction = options.direction ?? { x: 1, z: 0 }
  const magnitude = Math.hypot(direction.x, direction.z) || 1
  const normalized = { x: direction.x / magnitude, z: direction.z / magnitude }
  const halfX = Math.abs(normalized.x) * length * 0.5 + radius
  const halfZ = Math.abs(normalized.z) * length * 0.5 + radius
  const center = {
    x: options.center.x,
    y: options.center.y - radius * 0.35,
    z: options.center.z,
  }
  return {
    id: createModifierId('tunnel'),
    type: 'boolean-subtract',
    enabled: true,
    priority: 200,
    center,
    radius,
    length,
    direction: normalized,
    backend: 'analytic-tunnel-v1',
    bounds: {
      min: {
        x: center.x - halfX,
        y: center.y - radius * 1.5,
        z: center.z - halfZ,
      },
      max: {
        x: center.x + halfX,
        y: center.y + radius * 3.5,
        z: center.z + halfZ,
      },
    },
  }
}

export function createNoiseModifier(bounds: AABB): NoiseModifier {
  return {
    id: createModifierId('noise'),
    type: 'noise',
    enabled: true,
    priority: 10,
    bounds,
    amplitude: 5,
    frequency: 0.035,
    seed: 781,
  }
}
