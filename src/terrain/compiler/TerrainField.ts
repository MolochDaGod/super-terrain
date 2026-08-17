import { clamp, lerp, smoothstep } from '../core/bounds'
import { sampleHeight } from './heightField'
import type { Vec3Like } from '../core/types'
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
  for (const modifier of modifiers) {
    if (!modifier.enabled || modifier.type !== 'brush-stroke') continue
    applyBrushToPoint(point, base, modifier)
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
      clamp(modifier.strength, 0.01, 1) *
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
    }
  }
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
