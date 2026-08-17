import { boundsFromSphere, unionBounds } from '../core/bounds'
import type { AABB, Vec3Like } from '../core/types'
import {
  cutterBounds,
  unionBounds as unionCutterBounds,
  type CutterVolume,
} from './boolean/CutterVolume'
import type {
  BooleanSubtractModifier,
  BooleanVolumeModifier,
  BrushSample,
  BrushStrokeModifier,
  ModifierTransform,
  TerrainModifier,
} from './types'
import { normalizeTunnelModifier, tunnelBounds } from './tunnel'

export const IDENTITY_MODIFIER_TRANSFORM: ModifierTransform = {
  offset: { x: 0, y: 0, z: 0 },
  yaw: 0,
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
        : rotateNormal(sample.normal ?? { x: 0, y: 1, z: 0 }, transform.yaw)
    return { ...point, normal, weight: sample.weight ?? 1 }
  })
}

export function materializeModifierTransforms(
  modifiers: TerrainModifier[],
): TerrainModifier[] {
  return modifiers.map((modifier) => {
    const transform = normalizedTransform(modifier.transform)
    switch (modifier.type) {
      case 'brush-stroke': {
        const materialized: BrushStrokeModifier = {
          ...modifier,
          domain: modifier.domain ?? 'heightfield',
          points: transformedBrushSamples(modifier),
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
      normal: rotateNormal(portal.normal, transform.yaw),
    })) as BooleanSubtractModifier['portals'],
    radius: normalized.radius * transform.scale,
    depth: normalized.depth * transform.scale,
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
  switch (cutter.kind) {
    case 'sweep':
      return {
        ...cutter,
        rings: cutter.rings.map((ring) => ({
          ...transformPoint(ring, pivot, transform),
          horizontalRadius: ring.horizontalRadius * transform.scale,
          verticalRadius: ring.verticalRadius * transform.scale,
        })),
      }
    case 'capsule':
      return {
        ...cutter,
        start: transformPoint(cutter.start, pivot, transform),
        end: transformPoint(cutter.end, pivot, transform),
        radius: cutter.radius * transform.scale,
      }
    case 'ellipsoid':
      return {
        ...cutter,
        center: transformPoint(cutter.center, pivot, transform),
        radii: scaleVector(cutter.radii, transform.scale),
        forward: rotateNormal(cutter.forward, transform.yaw),
      }
    case 'box':
      return {
        ...cutter,
        center: transformPoint(cutter.center, pivot, transform),
        halfExtents: scaleVector(cutter.halfExtents, transform.scale),
        forward: rotateNormal(cutter.forward, transform.yaw),
      }
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
  const cosine = Math.cos(transform.yaw)
  const sine = Math.sin(transform.yaw)
  return {
    x: pivot.x + dx * cosine - dz * sine + transform.offset.x,
    y: pivot.y + dy + transform.offset.y,
    z: pivot.z + dx * sine + dz * cosine + transform.offset.z,
  }
}

function rotateNormal(normal: Vec3Like, yaw: number): Vec3Like {
  const cosine = Math.cos(yaw)
  const sine = Math.sin(yaw)
  const x = normal.x * cosine - normal.z * sine
  const z = normal.x * sine + normal.z * cosine
  const length = Math.hypot(x, normal.y, z) || 1
  return { x: x / length, y: normal.y / length, z: z / length }
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
  const cosine = Math.abs(Math.cos(transform.yaw))
  const sine = Math.abs(Math.sin(transform.yaw))
  const rotatedHalfX = halfX * cosine + halfZ * sine
  const rotatedHalfZ = halfX * sine + halfZ * cosine
  return {
    min: {
      x: center.x + transform.offset.x - rotatedHalfX,
      y: center.y + transform.offset.y - halfY,
      z: center.z + transform.offset.z - rotatedHalfZ,
    },
    max: {
      x: center.x + transform.offset.x + rotatedHalfX,
      y: center.y + transform.offset.y + halfY,
      z: center.z + transform.offset.z + rotatedHalfZ,
    },
  }
}
