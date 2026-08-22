import { boundsFromSphere, unionBounds } from '../core/bounds'
import type { AABB, Vec3Like } from '../core/types'
import {
  cutterBounds,
  unionBounds as unionCutterBounds,
  type CutterVolume,
  type TerrainApron,
} from './boolean/CutterVolume'
import type {
  BooleanSubtractModifier,
  BooleanVolumeModifier,
  BrushSample,
  BrushStrokeModifier,
  ModifierTransform,
  SculptLayerModifier,
  TerrainModifier,
  WeightPaintModifier,
} from './types'
import { normalizeTunnelModifier, tunnelBounds } from './tunnel'

export const IDENTITY_MODIFIER_TRANSFORM: ModifierTransform = {
  offset: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  roll: 0,
  scale: 1,
}

export function normalizedTransform(
  transform?: Partial<ModifierTransform>,
): ModifierTransform {
  return {
    offset: {
      x: transform?.offset?.x ?? 0,
      y: transform?.offset?.y ?? 0,
      z: transform?.offset?.z ?? 0,
    },
    yaw: transform?.yaw ?? 0,
    pitch: transform?.pitch ?? 0,
    roll: transform?.roll ?? 0,
    scale: Math.max(0.05, transform?.scale ?? 1),
  }
}

export function transformedBrushSamples(
  modifier: BrushStrokeModifier,
): BrushSample[] {
  const pivot = modifier.points[0] ?? {
    x: 0,
    y: 0,
    z: 0,
    normal: { x: 0, y: 1, z: 0 },
    weight: 1,
  }
  const transform = normalizedTransform(modifier.transform)
  return modifier.points.map((sample) => {
    const point = transformPoint(sample, pivot, transform)
    const normal =
      (modifier.domain ?? 'heightfield') === 'heightfield'
        ? { x: 0, y: 1, z: 0 }
        : rotateNormal(sample.normal ?? { x: 0, y: 1, z: 0 }, transform)
    return { ...point, normal, weight: sample.weight ?? 1 }
  })
}

export function materializeModifierTransforms(
  modifiers: TerrainModifier[],
): TerrainModifier[] {
  const sculptLayers = new Map(
    modifiers
      .filter((modifier): modifier is SculptLayerModifier => modifier.type === 'sculpt-layer')
      .map((layer) => [layer.id, layer]),
  )
  return modifiers.map((modifier) => {
    const transform = normalizedTransform(modifier.transform)
    switch (modifier.type) {
      case 'brush-stroke': {
        const materialized: BrushStrokeModifier = {
          ...modifier,
          domain: modifier.domain ?? 'heightfield',
          points: transformedBrushSamples(modifier),
          radius: modifier.radius * transform.scale,
          strength:
            modifier.strength *
            (modifier.sculptLayerId
              ? Math.max(0, Math.min(1, sculptLayers.get(modifier.sculptLayerId)?.opacity ?? 1))
              : 1),
          enabled:
            modifier.enabled &&
            (modifier.sculptLayerId
              ? (sculptLayers.get(modifier.sculptLayerId)?.enabled ?? true)
              : true),
          transform: normalizedTransform(),
        }
        materialized.bounds = modifierWorldBounds(materialized)
        return materialized
      }
      case 'weight-paint': {
        const pivot = modifier.points[0] ?? {
          x: 0,
          y: 0,
          z: 0,
          normal: { x: 0, y: 1, z: 0 },
          weight: 1,
        }
        const materialized: WeightPaintModifier = {
          ...modifier,
          points: modifier.points.map((sample) => ({
            ...transformPoint(sample, pivot, transform),
            normal: rotateNormal(sample.normal, transform),
            weight: sample.weight,
          })),
          radius: modifier.radius * transform.scale,
          transform: normalizedTransform(),
        }
        materialized.bounds = modifierWorldBounds(materialized)
        return materialized
      }
      case 'boolean-subtract':
        return transformedTunnel(modifier)
      case 'boolean-volume':
        return transformedBooleanVolume(modifier)
      case 'remesh':
      case 'tessellate': {
        const materialized = {
          ...modifier,
          center: transformedCenter(modifier.center, transform),
          radius: modifier.radius * transform.scale,
          targetEdgeLength: modifier.targetEdgeLength * transform.scale,
          transform: normalizedTransform(),
        }
        materialized.bounds = modifierWorldBounds(materialized)
        return materialized
      }
      case 'noise':
      case 'field-displacement':
      case 'sculpt-layer':
      case 'material-settings':
        return { ...modifier, transform }
    }
  })
}

export function transformedTunnel(
  modifier: BooleanSubtractModifier,
): BooleanSubtractModifier {
  const normalized = normalizeTunnelModifier(modifier)
  const transform = normalizedTransform(modifier.transform)
  const pivot = {
    x: (normalized.portals[0].x + normalized.portals[1].x) * 0.5,
    y: (normalized.portals[0].y + normalized.portals[1].y) * 0.5,
    z: (normalized.portals[0].z + normalized.portals[1].z) * 0.5,
  }
  const next: BooleanSubtractModifier = {
    ...normalized,
    portals: normalized.portals.map((portal) => ({
      ...transformPoint(portal, pivot, transform),
      normal: rotateNormal(portal.normal, transform),
    })) as BooleanSubtractModifier['portals'],
    radius: normalized.radius * transform.scale,
    depth: normalized.depth * transform.scale,
    noise: normalized.noise,
    // Noise is sampled in world space so transformed tunnels still agree at
    // streamed section seams; scaling the shape does not stretch that field.
    noiseScale: normalized.noiseScale,
    carves: normalized.carves?.map((cutter) =>
      transformCutterVolume(cutter, pivot, transform),
    ),
    transform: normalizedTransform(),
  }
  next.bounds = tunnelBounds(next)
  return next
}

export function transformedBooleanVolume(
  modifier: BooleanVolumeModifier,
): BooleanVolumeModifier {
  const transform = normalizedTransform(modifier.transform)
  const baseBounds = cutterVolumeBounds(modifier.volumes)
  const pivot = {
    x: (baseBounds.min.x + baseBounds.max.x) * 0.5,
    y: (baseBounds.min.y + baseBounds.max.y) * 0.5,
    z: (baseBounds.min.z + baseBounds.max.z) * 0.5,
  }
  const volumes = modifier.volumes.map((volume) =>
    transformCutterVolume(volume, pivot, transform),
  )
  return {
    ...modifier,
    volumes,
    bounds: cutterVolumeBounds(volumes),
    transform: normalizedTransform(),
  }
}

export function transformedCenter(
  center: Vec3Like,
  transform?: ModifierTransform,
): Vec3Like {
  const normalized = normalizedTransform(transform)
  return {
    x: center.x + normalized.offset.x,
    y: center.y + normalized.offset.y,
    z: center.z + normalized.offset.z,
  }
}

/** Stable, untransformed pivot used by the editor transform gizmo. */
export function modifierTransformPivot(modifier: TerrainModifier): Vec3Like {
  switch (modifier.type) {
    case 'brush-stroke':
    case 'weight-paint':
      return { ...(modifier.points[0] ?? { x: 0, y: 0, z: 0 }) }
    case 'boolean-subtract':
      return {
        x: (modifier.portals[0].x + modifier.portals[1].x) * 0.5,
        y: (modifier.portals[0].y + modifier.portals[1].y) * 0.5,
        z: (modifier.portals[0].z + modifier.portals[1].z) * 0.5,
      }
    case 'boolean-volume': {
      const bounds = cutterVolumeBounds(modifier.volumes)
      return {
        x: (bounds.min.x + bounds.max.x) * 0.5,
        y: (bounds.min.y + bounds.max.y) * 0.5,
        z: (bounds.min.z + bounds.max.z) * 0.5,
      }
    }
    case 'remesh':
    case 'tessellate':
      return { ...modifier.center }
    case 'noise':
    case 'field-displacement':
    case 'sculpt-layer':
    case 'material-settings':
      return {
        x: (modifier.bounds.min.x + modifier.bounds.max.x) * 0.5,
        y: (modifier.bounds.min.y + modifier.bounds.max.y) * 0.5,
        z: (modifier.bounds.min.z + modifier.bounds.max.z) * 0.5,
      }
  }
}

export function modifierWorldBounds(modifier: TerrainModifier): AABB {
  const transform = normalizedTransform(modifier.transform)
  switch (modifier.type) {
    case 'brush-stroke': {
      const samples = transformedBrushSamples(modifier)
      const radius = modifier.radius * transform.scale
      let bounds = boundsFromSphere(samples[0] ?? { x: 0, y: 0, z: 0 }, radius)
      for (let index = 1; index < samples.length; index += 1) {
        bounds = unionBounds(bounds, boundsFromSphere(samples[index], radius))
      }
      return bounds
    }
    case 'weight-paint': {
      const pivot = modifier.points[0] ?? {
        x: 0,
        y: 0,
        z: 0,
        normal: { x: 0, y: 1, z: 0 },
        weight: 1,
      }
      const radius = modifier.radius * transform.scale
      let bounds = boundsFromSphere(
        transformPoint(pivot, pivot, transform),
        radius,
      )
      for (let index = 1; index < modifier.points.length; index += 1) {
        bounds = unionBounds(
          bounds,
          boundsFromSphere(
            transformPoint(modifier.points[index], pivot, transform),
            radius,
          ),
        )
      }
      return bounds
    }
    case 'remesh':
    case 'tessellate':
      return boundsFromSphere(
        transformedCenter(modifier.center, transform),
        modifier.radius * transform.scale,
      )
    case 'boolean-subtract':
      return tunnelBounds(transformedTunnel(modifier))
    case 'boolean-volume':
      return transformedBooleanVolume(modifier).bounds
    case 'noise':
    case 'field-displacement':
      return transformBounds(modifier.bounds, transform)
    case 'sculpt-layer':
    case 'material-settings':
      return modifier.bounds
  }
}

function cutterVolumeBounds(volumes: readonly CutterVolume[]): AABB {
  return unionCutterBounds(volumes.map(cutterBounds)) ?? {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
  }
}

function transformCutterVolume(
  cutter: CutterVolume,
  pivot: Vec3Like,
  transform: ModifierTransform,
): CutterVolume {
  const terrainApron = transformTerrainApron(cutter.terrainApron, pivot, transform)
  switch (cutter.kind) {
    case 'sweep':
      return {
        ...cutter,
        terrainApron,
        rings: cutter.rings.map((ring) => ({
          ...transformPoint(ring, pivot, transform),
          horizontalRadius: ring.horizontalRadius * transform.scale,
          verticalRadius: ring.verticalRadius * transform.scale,
        })),
      }
    case 'capsule':
      return {
        ...cutter,
        terrainApron,
        start: transformPoint(cutter.start, pivot, transform),
        end: transformPoint(cutter.end, pivot, transform),
        radius: cutter.radius * transform.scale,
      }
    case 'ellipsoid':
      return {
        ...cutter,
        terrainApron,
        center: transformPoint(cutter.center, pivot, transform),
        radii: scaleVector(cutter.radii, transform.scale),
        forward: rotateNormal(cutter.forward, transform),
        up: rotateNormal(cutter.up ?? { x: 0, y: 1, z: 0 }, transform),
      }
    case 'box':
      return {
        ...cutter,
        terrainApron,
        center: transformPoint(cutter.center, pivot, transform),
        halfExtents: scaleVector(cutter.halfExtents, transform.scale),
        forward: rotateNormal(cutter.forward, transform),
        up: rotateNormal(cutter.up ?? { x: 0, y: 1, z: 0 }, transform),
      }
    case 'mesh':
      return {
        ...cutter,
        terrainApron,
        positions: transformMeshPositions(cutter.positions, pivot, transform),
        indices: [...cutter.indices],
      }
  }
}

function transformTerrainApron(
  apron: TerrainApron | undefined,
  pivot: Vec3Like,
  transform: ModifierTransform,
): TerrainApron | undefined {
  if (!apron) return undefined
  return {
    center: transformPoint(apron.center, pivot, transform),
    forward: rotateNormal(apron.forward, transform),
    halfLength: apron.halfLength * transform.scale,
    halfWidth: apron.halfWidth * transform.scale,
    falloff: apron.falloff * transform.scale,
    lift: apron.lift * transform.scale,
  }
}

function scaleVector(vector: Vec3Like, scale: number): Vec3Like {
  return { x: vector.x * scale, y: vector.y * scale, z: vector.z * scale }
}

function transformPoint(
  point: Vec3Like,
  pivot: Vec3Like,
  transform: ModifierTransform,
): Vec3Like {
  const dx = (point.x - pivot.x) * transform.scale
  const dy = (point.y - pivot.y) * transform.scale
  const dz = (point.z - pivot.z) * transform.scale
  const rotated = rotateVector({ x: dx, y: dy, z: dz }, transform)
  return {
    x: pivot.x + rotated.x + transform.offset.x,
    y: pivot.y + rotated.y + transform.offset.y,
    z: pivot.z + rotated.z + transform.offset.z,
  }
}

function rotateNormal(normal: Vec3Like, transform: ModifierTransform): Vec3Like {
  const rotated = rotateVector(normal, transform)
  const length = Math.hypot(rotated.x, rotated.y, rotated.z) || 1
  return {
    x: rotated.x / length,
    y: rotated.y / length,
    z: rotated.z / length,
  }
}

function rotateVector(vector: Vec3Like, transform: ModifierTransform): Vec3Like {
  const pitch = transform.pitch ?? 0
  const roll = transform.roll ?? 0
  const pitchCosine = Math.cos(pitch)
  const pitchSine = Math.sin(pitch)
  const pitchedY = vector.y * pitchCosine - vector.z * pitchSine
  const pitchedZ = vector.y * pitchSine + vector.z * pitchCosine
  const yawCosine = Math.cos(transform.yaw)
  const yawSine = Math.sin(transform.yaw)
  const yawedX = vector.x * yawCosine - pitchedZ * yawSine
  const yawedZ = vector.x * yawSine + pitchedZ * yawCosine
  const rollCosine = Math.cos(roll)
  const rollSine = Math.sin(roll)
  return {
    x: yawedX * rollCosine - pitchedY * rollSine,
    y: yawedX * rollSine + pitchedY * rollCosine,
    z: yawedZ,
  }
}

function transformMeshPositions(
  positions: readonly number[],
  pivot: Vec3Like,
  transform: ModifierTransform,
): number[] {
  const transformed: number[] = []
  for (let offset = 0; offset < positions.length; offset += 3) {
    const point = transformPoint(
      { x: positions[offset], y: positions[offset + 1], z: positions[offset + 2] },
      pivot,
      transform,
    )
    transformed.push(point.x, point.y, point.z)
  }
  return transformed
}

function transformBounds(
  bounds: AABB,
  transform: ModifierTransform,
): AABB {
  const center = {
    x: (bounds.min.x + bounds.max.x) * 0.5,
    y: (bounds.min.y + bounds.max.y) * 0.5,
    z: (bounds.min.z + bounds.max.z) * 0.5,
  }
  const halfX = (bounds.max.x - bounds.min.x) * 0.5 * transform.scale
  const halfY = (bounds.max.y - bounds.min.y) * 0.5 * transform.scale
  const halfZ = (bounds.max.z - bounds.min.z) * 0.5 * transform.scale
  const reach = Math.hypot(halfX, halfY, halfZ)
  return {
    min: {
      x: center.x + transform.offset.x - reach,
      y: center.y + transform.offset.y - reach,
      z: center.z + transform.offset.z - reach,
    },
    max: {
      x: center.x + transform.offset.x + reach,
      y: center.y + transform.offset.y + reach,
      z: center.z + transform.offset.z + reach,
    },
  }
}
