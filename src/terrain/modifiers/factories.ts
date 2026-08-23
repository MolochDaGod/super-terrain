import { boundsFromSphere, unionBounds } from '../core/bounds'
import type { AABB, Vec3Like } from '../core/types'
import {
  cloneCutterVolume,
  cutterBounds,
  unionBounds as unionCutterBounds,
  type CutterVolume,
} from './boolean/CutterVolume'
import type {
  BooleanSubtractModifier,
  BooleanVolumeModifier,
  BrushDomain,
  BrushMode,
  BrushStrokeModifier,
  CsgOperation,
  MaterialSettingsModifier,
  NoiseModifier,
  PaintMode,
  RemeshModifier,
  SculptLayerModifier,
  TessellateModifier,
  TunnelPortal,
  WeightPaintModifier,
} from './types'
import { createTunnelPortals, tunnelBounds } from './tunnel'
import {
  cloneTerrainMaterialSettings,
  type TerrainMaterialSettings,
  type TerrainPaintChannelId,
} from '../rendering/materialSettings'

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
  normal?: Vec3Like
  domain?: BrushDomain
  mode: BrushMode
  radius: number
  strength: number
  falloff: number
  targetY?: number
  terraceStep?: number
  noiseScale?: number
  accumulate?: boolean
  sculptLayerId?: string
  sampleWeight?: number
}): BrushStrokeModifier {
  return {
    id: createModifierId('stroke'),
    type: 'brush-stroke',
    enabled: true,
    priority: 100,
    bounds: boundsFromSphere(options.point, options.radius),
    mode: options.mode,
    domain: options.domain ?? 'mesh',
    radius: options.radius,
    strength: options.strength,
    falloff: options.falloff,
    targetY: options.targetY,
    terraceStep: options.terraceStep,
    noiseScale: options.noiseScale,
    noiseSeed: Math.floor(Math.random() * 0x7fff_ffff),
    accumulate: options.accumulate,
    sculptLayerId: options.sculptLayerId,
    points: [
      {
        ...options.point,
        normal: normalize3(options.normal ?? { x: 0, y: 1, z: 0 }),
        weight: options.sampleWeight ?? 1,
      },
    ],
    transform: identityTransform(),
  }
}

export function createWeightPaintStroke(options: {
  point: Vec3Like
  normal?: Vec3Like
  channel: TerrainPaintChannelId
  mode: PaintMode
  radius: number
  strength: number
  falloff: number
  sampleWeight?: number
}): WeightPaintModifier {
  return {
    id: createModifierId('paint'),
    type: 'weight-paint',
    enabled: true,
    priority: 400,
    bounds: boundsFromSphere(options.point, options.radius),
    channel: options.channel,
    mode: options.mode,
    radius: options.radius,
    strength: options.strength,
    falloff: options.falloff,
    points: [{
      ...options.point,
      normal: normalize3(options.normal ?? { x: 0, y: 1, z: 0 }),
      weight: options.sampleWeight ?? 1,
    }],
    transform: identityTransform(),
  }
}

export function createSculptLayerModifier(
  name: string,
  priority = 100,
): SculptLayerModifier {
  return {
    id: createModifierId('sculpt-layer'),
    type: 'sculpt-layer',
    enabled: true,
    priority,
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
    },
    name,
    opacity: 1,
    transform: identityTransform(),
  }
}

export function createMaterialSettingsModifier(
  settings?: TerrainMaterialSettings,
): MaterialSettingsModifier {
  return {
    id: 'terrain-material-settings',
    type: 'material-settings',
    enabled: true,
    priority: 10_000,
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
    },
    settings: cloneTerrainMaterialSettings(settings),
    transform: identityTransform(),
  }
}

export function appendBrushPoint(
  modifier: BrushStrokeModifier | WeightPaintModifier,
  point: Vec3Like,
  normal: Vec3Like = { x: 0, y: 1, z: 0 },
  weight = 1,
): AABB {
  modifier.points.push({
    ...point,
    normal: normalize3(normal),
    weight,
  })
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
    transform: identityTransform(),
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
    transform: identityTransform(),
  }
}

export function createTunnelModifier(options: {
  center?: Vec3Like
  start?: TunnelPortal
  end?: TunnelPortal
  radius?: number
  depth?: number
  length?: number
  direction?: { x: number; z: number }
  noise?: number
  noiseScale?: number
}): BooleanSubtractModifier {
  const radius = options.radius ?? 8
  const modifier: BooleanSubtractModifier = {
    id: createModifierId('tunnel'),
    type: 'boolean-subtract',
    shape: 'capsule-path',
    enabled: true,
    priority: 200,
    portals: createTunnelPortals(options),
    radius,
    depth: options.depth ?? radius * 1.75,
    noise: Math.max(0, options.noise ?? 1),
    noiseScale: Math.max(0.25, options.noiseScale ?? 2.6),
    backend: 'bvh-csg-tunnel-v3',
    transform: identityTransform(),
    bounds: boundsFromSphere(options.start ?? options.center ?? { x: 0, y: 0, z: 0 }, radius),
  }
  modifier.bounds = tunnelBounds(modifier)
  return modifier
}

export function createBooleanVolumeModifier(options: {
  volumes: CutterVolume[]
  operation?: CsgOperation
}): BooleanVolumeModifier {
  const bounds = unionCutterBounds(options.volumes.map(cutterBounds)) ?? {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
  }
  return {
    id: createModifierId('volume'),
    type: 'boolean-volume',
    operation: options.operation ?? 'subtract',
    enabled: true,
    priority: 190,
    volumes: options.volumes.map(cloneCutterVolume),
    backend: 'bvh-csg-volume-v1',
    bounds,
    transform: identityTransform(),
  }
}

function normalize3(value: Vec3Like): Vec3Like {
  const length = Math.hypot(value.x, value.y, value.z) || 1
  return { x: value.x / length, y: value.y / length, z: value.z / length }
}

function identityTransform() {
  return {
    offset: { x: 0, y: 0, z: 0 },
    yaw: 0,
    scale: 1,
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
    transform: identityTransform(),
  }
}
