import type { Vec3 } from './types.ts'

export const PI = Math.PI
export const TAU = Math.PI * 2
export const INV_PI = 1 / Math.PI
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s]
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function length3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2])
}

export function normalize3(a: Vec3): Vec3 {
  const len = length3(a)
  if (len < 1e-8) return [0, 1, 0]
  return [a[0] / len, a[1] / len, a[2] / len]
}

export function maxAbs3(a: Vec3): number {
  return Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2]))
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/**
 * Integer hash used by the world radiance cache (Sousa / Gautron 2020).
 * Output is in [0, 2^32).
 */
export function hashInt(value: number): number {
  let x = value | 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

export function hashCombine(a: number, b: number): number {
  return hashInt((a + Math.imul(b, 0x9e3779b9)) | 0)
}

/**
 * Uniform spherical Fibonacci lattice. Probe visibility rays use this so every
 * cell center covers the same directions across frames (Sousa traces a budgeted
 * N rays per probe; we keep the set stable and rotate by a per-frame offset).
 */
export function fibonacciSphere(count: number, index: number, rotate = 0): Vec3 {
  const n = Math.max(count, 1)
  const i = ((index % n) + n) % n
  const y = 1 - (i / Math.max(n - 1, 1)) * 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const phi = i * GOLDEN_ANGLE + rotate
  return [Math.cos(phi) * r, y, Math.sin(phi) * r]
}

/** Cosine-weighted hemisphere around `normal` (final gather). */
export function cosineHemisphere(normal: Vec3, u: number, v: number): Vec3 {
  const r = Math.sqrt(Math.max(0, u))
  const phi = TAU * v
  const x = r * Math.cos(phi)
  const y = r * Math.sin(phi)
  const z = Math.sqrt(Math.max(0, 1 - u))
  const up: Vec3 = Math.abs(normal[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0]
  const tangent = normalize3([
    up[1] * normal[2] - up[2] * normal[1],
    up[2] * normal[0] - up[0] * normal[2],
    up[0] * normal[1] - up[1] * normal[0],
  ])
  const bitangent: Vec3 = [
    normal[1] * tangent[2] - normal[2] * tangent[1],
    normal[2] * tangent[0] - normal[0] * tangent[2],
    normal[0] * tangent[1] - normal[1] * tangent[0],
  ]
  return normalize3([
    tangent[0] * x + bitangent[0] * y + normal[0] * z,
    tangent[1] * x + bitangent[1] * y + normal[1] * z,
    tangent[2] * x + bitangent[2] * y + normal[2] * z,
  ])
}

/** Interleaved gradient noise, cheap blue-noise stand-in for gather jitter. */
export function interleavedGradientNoise(x: number, y: number, frame = 0): number {
  const f = 0.06711056 * (x + frame * 1.618) + 0.00583715 * y
  return f - Math.floor(f)
}
