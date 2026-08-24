import type { TreeBounds, TreeVec3 } from './types'

export class TreeRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0 || 1
  }

  unit(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }

  range(minimum: number, maximum: number): number {
    return minimum + (maximum - minimum) * this.unit()
  }

  signed(): number {
    return this.unit() * 2 - 1
  }

  integer(minimum: number, maximumInclusive: number): number {
    return Math.floor(this.range(minimum, maximumInclusive + 1))
  }
}

export const vec3 = (x = 0, y = 0, z = 0): TreeVec3 => ({ x, y, z })

export function add(a: TreeVec3, b: TreeVec3): TreeVec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

export function subtract(a: TreeVec3, b: TreeVec3): TreeVec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

export function multiply(value: TreeVec3, scale: number): TreeVec3 {
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale }
}

export function dot(a: TreeVec3, b: TreeVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function cross(a: TreeVec3, b: TreeVec3): TreeVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

export function length(value: TreeVec3): number {
  return Math.hypot(value.x, value.y, value.z)
}

export function lengthSquared(value: TreeVec3): number {
  return dot(value, value)
}

export function normalize(value: TreeVec3, fallback: TreeVec3 = vec3(0, 1, 0)): TreeVec3 {
  const magnitude = length(value)
  return magnitude > 1e-9 ? multiply(value, 1 / magnitude) : { ...fallback }
}

export function lerp(a: TreeVec3, b: TreeVec3, amount: number): TreeVec3 {
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
    z: a.z + (b.z - a.z) * amount,
  }
}

export function lerpNumber(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 < edge0) return 1 - smoothstep(edge1, edge0, value)
  const amount = clamp((value - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1)
  return amount * amount * (3 - 2 * amount)
}

export function rotateAroundY(value: TreeVec3, angle: number): TreeVec3 {
  const sine = Math.sin(angle)
  const cosine = Math.cos(angle)
  return {
    x: value.x * cosine - value.z * sine,
    y: value.y,
    z: value.x * sine + value.z * cosine,
  }
}

export function groundHeightAt(
  x: number,
  z: number,
  groundHeight: number,
  slopeX: number,
  slopeZ: number,
): number {
  return groundHeight + x * slopeX + z * slopeZ
}

export function emptyBounds(): TreeBounds {
  return {
    min: vec3(Infinity, Infinity, Infinity),
    max: vec3(-Infinity, -Infinity, -Infinity),
  }
}

export function includeInBounds(
  bounds: TreeBounds,
  point: TreeVec3,
  padding = 0,
): void {
  bounds.min.x = Math.min(bounds.min.x, point.x - padding)
  bounds.min.y = Math.min(bounds.min.y, point.y - padding)
  bounds.min.z = Math.min(bounds.min.z, point.z - padding)
  bounds.max.x = Math.max(bounds.max.x, point.x + padding)
  bounds.max.y = Math.max(bounds.max.y, point.y + padding)
  bounds.max.z = Math.max(bounds.max.z, point.z + padding)
}

export function hashUnit(seed: number, x: number, y: number, z: number): number {
  let value = seed | 0
  value ^= Math.imul(Math.floor(x * 8192), 0x45d9f3b)
  value ^= Math.imul(Math.floor(y * 8192), 0x119de1f3)
  value ^= Math.imul(Math.floor(z * 8192), 0x3449f)
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d)
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295
}
