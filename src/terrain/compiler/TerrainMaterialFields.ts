import { clamp, smoothstep } from '../core/bounds'
import { sampleHeightFieldCached } from './heightField'

export interface TerrainMaterialFields {
  regional: number
  /** Regolith depth proxy in 0..1: where loose material can come to rest. */
  deposition: number
  /** Ground water availability in 0..1, from drainage and altitude. */
  moisture: number
  macro: number
  /** Unit normal of the local bedding planes, shared with the mesh terracing. */
  beddingX: number
  beddingY: number
  beddingZ: number
  bedThickness: number
  /** 0..1 strength of bedding expression, shared with the mesh terracing. */
  bedExposure: number
  jointing: number
  lichen: number
  mottle: number
  beddedOffsetX: number
  beddedOffsetY: number
  beddedOffsetZ: number
  regionalTint: number
  buttress: number
  /** 0..1 proximity to a drainage line: the path water actually takes. */
  flow: number
}

interface Point3 {
  x: number
  y: number
  z: number
}

/** Metres of bed thickness the packed unit value spans. */
export const BED_THICKNESS_MIN = 9
export const BED_THICKNESS_MAX = 26

/**
 * Broad material fields, evaluated once per vertex by the section worker and
 * interpolated by the rasteriser.
 *
 * The fields that decide *what a surface is made of* are read from the terrain
 * itself — the drainage network, the local slope, the bedding attitude that the
 * mesh was terraced with — rather than from independent noise. A noise field
 * thresholded into a mask can only ever produce a plausible-looking blob; it
 * has no reason to put scree beneath a cliff, moss in a gully or a bench where
 * a resistant bed outcrops, so it produces terrain that is busy without being
 * coherent. Reading the same quantities the landform was built from costs
 * nothing extra here and is the difference.
 *
 * What remains noise-driven is only genuine small-scale material variation —
 * lichen, mottling, jointing density — where noise is the honest model.
 *
 * The Perlin implementation mirrors MaterialX's, including its Jenkins hash and
 * gradient scale, so these agree exactly with the fragment shader's own taps.
 */
export function evaluateTerrainMaterialFields(
  x: number,
  y: number,
  z: number,
  seed: number,
): TerrainMaterialFields {
  const position = { x, y, z }
  const firstWarp = warp(position, 9.5, 0.021)
  const bedded = warp(firstWarp, 1.6, 0.1373)
  const buttressPosition = warp(position, 11, 0.02)

  const terrain = sampleHeightFieldCached(x, z, seed)
  const { bedding } = terrain

  // Slope from the height stack rather than the mesh normal, so it survives LOD
  // changes and skirt vertices unchanged.
  const slope = clamp(terrain.steepness, 0, 3)

  // Water collects in the carved drainage lines and thins out with altitude,
  // where there is less catchment above and more of the year is frozen.
  const altitudeDrying = smoothstep(210, 540, y)
  const flow = terrain.flow
  const moisture = clamp(
    0.4 +
      flow * 0.5 +
      (1 - smoothstep(0.45, 1.4, slope)) * 0.24 -
      altitudeDrying * 0.42 +
      (fbm(position, 150, 2) - 0.5) * 0.3,
    0,
    1,
  )

  // How much loose material this part of the range is supplied with and can
  // keep at the catchment scale: drainage lines collect it, and whole faces
  // steep enough to shed everything supply it. The per-pixel decision about
  // whether it can rest on *this* gradient belongs to the shader, which knows
  // the real surface normal; this is only the budget it draws from.
  const deposition = clamp(
    0.62 +
      flow * 0.3 -
      smoothstep(0.9, 2.1, slope) * 0.5 +
      (fbm(position, 46, 2) - 0.5) * 0.34,
    0,
    1,
  )

  return {
    regional: perlin3(x * 0.011, y * 0.011, z * 0.011),
    deposition,
    moisture,
    macro: fbm(position, 34, 3),
    beddingX: bedding.normalX,
    beddingY: bedding.normalY,
    beddingZ: bedding.normalZ,
    bedThickness: clamp(
      (bedding.thickness - BED_THICKNESS_MIN) /
        (BED_THICKNESS_MAX - BED_THICKNESS_MIN),
      0,
      1,
    ),
    bedExposure: bedding.expression,
    jointing: fbm(position, 24, 2),
    lichen: fbm(position, 9, 3),
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
    flow,
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
