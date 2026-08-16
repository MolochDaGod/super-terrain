import { clamp } from '../core/bounds'

export interface TerrainMaterialFields {
  regional: number
  patch: number
  moisture: number
  macro: number
  dipAngle: number
  dipAzimuth: number
  bedThickness: number
  bedExposure: number
  jointing: number
  lichen: number
  outcrop: number
  mottle: number
  beddedOffsetX: number
  beddedOffsetY: number
  beddedOffsetZ: number
  regionalTint: number
  buttress: number
}

interface Point3 {
  x: number
  y: number
  z: number
}

/**
 * CPU counterpart of the broad fields in the full terrain material. These
 * values are evaluated once by the section worker and then interpolated by the
 * rasterizer. The implementation mirrors MaterialX's 3D Perlin noise, including
 * its Jenkins hash and gradient scale, so moving the work out of the vertex
 * shader does not replace the authored field with a cheaper approximation.
 */
export function evaluateTerrainMaterialFields(
  x: number,
  y: number,
  z: number,
): TerrainMaterialFields {
  const position = { x, y, z }
  const firstWarp = warp(position, 9.5, 0.021)
  const bedded = warp(firstWarp, 1.6, 0.1373)
  const buttressPosition = warp(position, 11, 0.02)

  return {
    regional: perlin3(x * 0.011, y * 0.011, z * 0.011),
    patch: fbm(position, 46, 3),
    moisture: fbm(position, 150, 3),
    macro: fbm(position, 34, 3),
    dipAngle: fbm(position, 900, 1),
    dipAzimuth: fbm(position, 1_400, 1),
    bedThickness: fbm(position, 420, 1),
    bedExposure: fbm(position, 85, 3),
    jointing: fbm(position, 24, 2),
    lichen: fbm(position, 9, 3),
    outcrop: ridged({ x, y: y * 0.35, z }, 17, 3),
    mottle: fbm(position, 14, 2),
    beddedOffsetX: bedded.x - x,
    beddedOffsetY: bedded.y - y,
    beddedOffsetZ: bedded.z - z,
    regionalTint: fbm(position, 220, 2),
    buttress: ridged(
      { x: buttressPosition.x, y: buttressPosition.y * 0.6, z: buttressPosition.z },
      9,
      3,
    ),
  }
}

function fbm(position: Point3, wavelength: number, octaves: number): number {
  let sum = 0
  let total = 0.0001
  let amplitude = 1
  let scale = 1 / wavelength
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += perlin3(
      position.x * scale,
      position.y * scale,
      position.z * scale,
    ) * amplitude
    total += amplitude
    amplitude *= 0.52
    scale *= 2.07
  }
  return clamp(sum / total * 0.5 + 0.5, 0, 1)
}

function ridged(position: Point3, wavelength: number, octaves: number): number {
  let sum = 0
  let total = 0.0001
  let amplitude = 1
  let scale = 1 / wavelength
  let carry = 1
  for (let octave = 0; octave < octaves; octave += 1) {
    const ridge = 1 - Math.abs(perlin3(
      position.x * scale,
      position.y * scale,
      position.z * scale,
    ))
    const shaped = ridge * ridge * carry
    carry = clamp(shaped * 2.1, 0, 1)
    sum += shaped * amplitude
    total += amplitude
    amplitude *= 0.55
    scale *= 2.07
  }
  return clamp(sum / total, 0, 1)
}

function warp(position: Point3, amount: number, frequency: number): Point3 {
  const sx = position.x * frequency
  const sy = position.y * frequency
  const sz = position.z * frequency
  const a = perlin3(sx, sy, sz)
  const b = perlin3(
    sy * -1.13 + 19.7,
    sz * -1.13 + 19.7,
    sx * -1.13 + 19.7,
  )
  return {
    x: position.x + a * amount,
    y: position.y + b * amount,
    z: position.z + (a * 0.7 - b * 0.7) * amount,
  }
}

function perlin3(x: number, y: number, z: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const u = fade(fx)
  const v = fade(fy)
  const w = fade(fz)

  const n000 = gradient(hash3(ix, iy, iz), fx, fy, fz)
  const n100 = gradient(hash3(ix + 1, iy, iz), fx - 1, fy, fz)
  const n010 = gradient(hash3(ix, iy + 1, iz), fx, fy - 1, fz)
  const n110 = gradient(hash3(ix + 1, iy + 1, iz), fx - 1, fy - 1, fz)
  const n001 = gradient(hash3(ix, iy, iz + 1), fx, fy, fz - 1)
  const n101 = gradient(hash3(ix + 1, iy, iz + 1), fx - 1, fy, fz - 1)
  const n011 = gradient(hash3(ix, iy + 1, iz + 1), fx, fy - 1, fz - 1)
  const n111 = gradient(hash3(ix + 1, iy + 1, iz + 1), fx - 1, fy - 1, fz - 1)

  const x00 = lerp(n000, n100, u)
  const x10 = lerp(n010, n110, u)
  const x01 = lerp(n001, n101, u)
  const x11 = lerp(n011, n111, u)
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 0.982
}

function gradient(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15
  const u = h < 8 ? x : y
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z
  return (h & 1 ? -u : u) + (h & 2 ? -v : v)
}

function hash3(x: number, y: number, z: number): number {
  const seed = (0xdeadbeef + (3 << 2) + 13) >>> 0
  return bjFinal(
    (seed + (x >>> 0)) >>> 0,
    (seed + (y >>> 0)) >>> 0,
    (seed + (z >>> 0)) >>> 0,
  )
}

function bjFinal(initialA: number, initialB: number, initialC: number): number {
  let a = initialA >>> 0
  let b = initialB >>> 0
  let c = initialC >>> 0
  c = (c ^ b) >>> 0
  c = (c - rotateLeft(b, 14)) >>> 0
  a = (a ^ c) >>> 0
  a = (a - rotateLeft(c, 11)) >>> 0
  b = (b ^ a) >>> 0
  b = (b - rotateLeft(a, 25)) >>> 0
  c = (c ^ b) >>> 0
  c = (c - rotateLeft(b, 16)) >>> 0
  a = (a ^ c) >>> 0
  a = (a - rotateLeft(c, 4)) >>> 0
  b = (b ^ a) >>> 0
  b = (b - rotateLeft(a, 14)) >>> 0
  c = (c ^ b) >>> 0
  return (c - rotateLeft(b, 24)) >>> 0
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function fade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10)
}

function lerp(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}
