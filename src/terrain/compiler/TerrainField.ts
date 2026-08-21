import { clamp, lerp, smoothstep } from '../core/bounds'
import { sampleHeight } from './heightField'
import type { Vec3Like } from '../core/types'
import type { TerrainApron } from '../modifiers/boolean/CutterVolume'
import type {
  BrushStrokeModifier,
  TerrainModifier,
} from '../modifiers/types'

export function evaluateHeight(
  worldX: number,
  worldZ: number,
  seed: number,
  modifiers: TerrainModifier[],
): number {
  let height = sampleHeight(worldX, worldZ, seed)

  for (const modifier of modifiers) {
    if (!modifier.enabled) continue
    switch (modifier.type) {
      case 'noise': {
        const noise = valueNoise(
          worldX * modifier.frequency,
          worldZ * modifier.frequency,
          modifier.seed,
        )
        height += (noise * 2 - 1) * modifier.amplitude
        break
      }
      case 'field-displacement':
        height +=
          Math.sin(worldX * 0.018 + worldZ * 0.011) * modifier.scale * 0.5
        break
      case 'brush-stroke':
      case 'weight-paint':
      case 'sculpt-layer':
      case 'material-settings':
      case 'boolean-subtract':
      case 'boolean-volume':
      case 'remesh':
      case 'tessellate':
        break
    }
  }
  return height
}

/** Maps procedural surface coordinates into an authored point in 3D space. */
export function evaluateTerrainPoint(
  worldX: number,
  worldZ: number,
  seed: number,
  modifiers: TerrainModifier[],
): Vec3Like {
  const base = {
    x: worldX,
    y: evaluateHeight(worldX, worldZ, seed, modifiers),
    z: worldZ,
  }
  const point = { ...base }

  // Grow the cheap source surface into additive mesh patches before exact CSG.
  // The Boolean still owns every overhang and opening; this only supplies a
  // broad, low-frequency geological root on the terrain side of the join.
  let apronLift = 0
  for (const modifier of modifiers) {
    if (
      !modifier.enabled ||
      modifier.type !== 'boolean-volume' ||
      modifier.operation !== 'add'
    ) {
      continue
    }
    for (const volume of modifier.volumes) {
      if (!volume.terrainApron) continue
      apronLift = Math.max(
        apronLift,
        terrainApronLift(worldX, worldZ, volume.terrainApron),
      )
    }
  }
  point.y += apronLift
  const integratedBase = { ...point }
  for (const modifier of modifiers) {
    if (!modifier.enabled || modifier.type !== 'brush-stroke') continue
    applyBrushToPoint(point, integratedBase, modifier)
  }
  return point
}

/** Smooth radial distance to an oriented ellipse, with a metre-space falloff. */
export function terrainApronLift(
  worldX: number,
  worldZ: number,
  apron: TerrainApron,
): number {
  const forwardLength = Math.hypot(apron.forward.x, apron.forward.z) || 1
  const forwardX = apron.forward.x / forwardLength
  const forwardZ = apron.forward.z / forwardLength
  const sideX = -forwardZ
  const sideZ = forwardX
  const dx = worldX - apron.center.x
  const dz = worldZ - apron.center.z
  const along = dx * forwardX + dz * forwardZ
  const across = dx * sideX + dz * sideZ
  const distance = Math.hypot(along, across)
  const halfLength = Math.max(0.25, apron.halfLength)
  const halfWidth = Math.max(0.25, apron.halfWidth)

  // Radius of the core ellipse in the direction of this sample. This avoids
  // an AABB-shaped mound around oblique sheets while keeping evaluation O(1).
  let coreRadius = Math.min(halfLength, halfWidth)
  if (distance > 1e-6) {
    const directionX = along / distance
    const directionZ = across / distance
    coreRadius = 1 / Math.sqrt(
      (directionX * directionX) / (halfLength * halfLength) +
      (directionZ * directionZ) / (halfWidth * halfWidth),
    )
  }
  const falloff = Math.max(0.25, apron.falloff)
  if (distance >= coreRadius + falloff) return 0
  const influence = distance <= coreRadius
    ? 1
    : 1 - smoothstep(coreRadius, coreRadius + falloff, distance)

  // A tiny continuous warp prevents the apron edge becoming a mathematically
  // perfect contour, without adding another modifier or any random state.
  const geologicalVariation =
    0.9 + Math.sin(worldX * 0.037 + worldZ * 0.051) * 0.065 +
    Math.sin(worldX * 0.091 - worldZ * 0.043) * 0.035
  return Math.max(0, apron.lift) * influence * geologicalVariation
}

/** Applies the same non-destructive field stack to an arbitrary source point. */
export function evaluateEditableTerrainPoint(
  sourcePoint: Vec3Like,
  sourceNormal: Vec3Like,
  modifiers: TerrainModifier[],
): Vec3Like {
  const base = { ...sourcePoint }
  const point = { ...sourcePoint }
  const normalLength = Math.hypot(
    sourceNormal.x,
    sourceNormal.y,
    sourceNormal.z,
  ) || 1
  const normal = {
    x: sourceNormal.x / normalLength,
    y: sourceNormal.y / normalLength,
    z: sourceNormal.z / normalLength,
  }

  for (const modifier of modifiers) {
    if (!modifier.enabled) continue
    switch (modifier.type) {
      case 'noise': {
        const noise = valueNoise(
          sourcePoint.x * modifier.frequency,
          sourcePoint.z * modifier.frequency,
          modifier.seed,
        )
        displaceAlongNormal(point, normal, (noise * 2 - 1) * modifier.amplitude)
        break
      }
      case 'field-displacement': {
        const displacement =
          Math.sin(sourcePoint.x * 0.018 + sourcePoint.z * 0.011) *
          modifier.scale *
          0.5
        displaceAlongNormal(point, normal, displacement)
        break
      }
      case 'brush-stroke':
        applyBrushToPoint(point, base, modifier)
        break
      case 'weight-paint':
      case 'sculpt-layer':
      case 'material-settings':
      case 'boolean-subtract':
      case 'boolean-volume':
      case 'remesh':
      case 'tessellate':
        break
    }
  }
  return point
}

export function hasLateralDisplacement(
  modifiers: TerrainModifier[],
): boolean {
  return modifiers.some(
    (modifier) =>
      modifier.type === 'brush-stroke' &&
      modifier.points.some((point) =>
        Math.hypot(point.normal?.x ?? 0, point.normal?.z ?? 0) > 0.01,
      ),
  )
}

function applyBrushToPoint(
  point: Vec3Like,
  base: Vec3Like,
  modifier: BrushStrokeModifier,
): void {
  for (const sample of modifier.points) {
    const dx = point.x - sample.x
    const dy = point.y - sample.y
    const dz = point.z - sample.z
    const isHeightfield = modifier.domain === 'heightfield'
    const distance = isHeightfield ? Math.hypot(dx, dz) : Math.hypot(dx, dy, dz)
    if (distance >= modifier.radius) continue
    const radial = 1 - distance / modifier.radius
    const weight =
      smoothstep(0, 1, radial) ** (0.55 + modifier.falloff * 2.4) *
      clamp(modifier.strength, 0, 1) *
      Math.max(0, sample.weight ?? 1)
    const normal = sample.normal ?? { x: 0, y: 1, z: 0 }
    const normalLength = Math.hypot(normal.x, normal.y, normal.z) || 1
    const nx = normal.x / normalLength
    const ny = normal.y / normalLength
    const nz = normal.z / normalLength

    switch (modifier.mode) {
      case 'raise':
      case 'lower': {
        const sign = modifier.mode === 'raise' ? 1 : -1
        const displacement = weight * 2.8 * sign
        point.x += nx * displacement
        point.y += ny * displacement
        point.z += nz * displacement
        break
      }
      case 'flatten': {
        const planeDistance = isHeightfield
          ? point.y - (modifier.targetY ?? sample.y)
          : dx * nx + dy * ny + dz * nz
        const displacement = -planeDistance * clamp(weight * 0.48, 0, 1)
        point.x += nx * displacement
        point.y += ny * displacement
        point.z += nz * displacement
        break
      }
      case 'smooth': {
        const amount = clamp(weight * 0.34, 0, 1)
        if (!isHeightfield) point.x = lerp(point.x, base.x, amount)
        point.y = lerp(point.y, base.y, amount)
        if (!isHeightfield) point.z = lerp(point.z, base.z, amount)
        break
      }
      case 'clay': {
        // A broad, slightly flattened buildup like ZBrush/Blender clay strips.
        const displacement = Math.min(weight * 3.4, radial * modifier.strength * 1.5)
        point.x += nx * displacement
        point.y += ny * displacement
        point.z += nz * displacement
        break
      }
      case 'pinch': {
        // Pull vertices toward the dab center in the tangent plane while
        // preserving the surface's normal depth.
        const towardX = -dx
        const towardY = -dy
        const towardZ = -dz
        const normalComponent = towardX * nx + towardY * ny + towardZ * nz
        const amount = clamp(weight * 0.32, 0, 0.45)
        point.x += (towardX - nx * normalComponent) * amount
        point.y += (towardY - ny * normalComponent) * amount
        point.z += (towardZ - nz * normalComponent) * amount
        break
      }
      case 'scrape': {
        const planeDistance = isHeightfield
          ? point.y - (modifier.targetY ?? sample.y)
          : dx * nx + dy * ny + dz * nz
        if (planeDistance <= 0) break
        const displacement = -planeDistance * clamp(weight * 0.7, 0, 1)
        point.x += nx * displacement
        point.y += ny * displacement
        point.z += nz * displacement
        break
      }
      case 'terrace': {
        const step = Math.max(0.25, modifier.terraceStep ?? 4)
        const target = Math.round(point.y / step) * step
        point.y = lerp(point.y, target, clamp(weight * 0.65, 0, 1))
        break
      }
      case 'noise': {
        const scale = Math.max(0.15, modifier.noiseScale ?? 3)
        const noise = hash3(
          Math.floor(point.x / scale),
          Math.floor(point.y / scale),
          Math.floor(point.z / scale),
          modifier.noiseSeed ?? 1,
        ) * 2 - 1
        const displacement = noise * weight * 3.2
        point.x += nx * displacement
        point.y += ny * displacement
        point.z += nz * displacement
        break
      }
    }
  }
}

function displaceAlongNormal(
  point: Vec3Like,
  normal: Vec3Like,
  distance: number,
): void {
  point.x += normal.x * distance
  point.y += normal.y * distance
  point.z += normal.z * distance
}

function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x)
  const z0 = Math.floor(z)
  const tx = smoothstep(0, 1, x - x0)
  const tz = smoothstep(0, 1, z - z0)
  const a = hash2(x0, z0, seed)
  const b = hash2(x0 + 1, z0, seed)
  const c = hash2(x0, z0 + 1, seed)
  const d = hash2(x0 + 1, z0 + 1, seed)
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz)
}

function hash2(x: number, z: number, seed: number): number {
  let value = Math.imul(x, 374_761_393) + Math.imul(z, 668_265_263)
  value = (value ^ (value >>> 13)) + Math.imul(seed, 1_443_053)
  value = Math.imul(value ^ (value >>> 16), 1_274_126_177)
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let value =
    Math.imul(x, 374_761_393) ^
    Math.imul(y, 668_265_263) ^
    Math.imul(z, 2_147_483_647) ^
    seed
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177)
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295
}
