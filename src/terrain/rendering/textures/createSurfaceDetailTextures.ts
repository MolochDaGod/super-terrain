import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
} from 'three/webgpu'

/**
 * Small tileable surface bakes used by the realtime materials.
 *
 * The old full-quality shaders evaluated dozens of gradient-noise functions
 * for every covered pixel. These textures move the invariant part of that work
 * to a one-off CPU bake. Triplanar sampling keeps them continuous across the
 * independently streamed terrain sections and the height channel still drives
 * a real per-pixel normal, so the cheaper path is also the sharper one.
 */
export function createGeologyDetailTexture(size = 256): DataTexture {
  const pixels = new Uint8Array(size * size * 4)

  for (let y = 0; y < size; y += 1) {
    const v = y / size
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      const broad =
        tileableValueNoise(u, v, 6, 1_771) * 0.55 +
        tileableValueNoise(u, v, 17, 9_137) * 0.3 +
        tileableValueNoise(u, v, 43, 18_731) * 0.15
      const grain =
        tileableValueNoise(u, v, 31, 29_011) * 0.65 +
        tileableValueNoise(u, v, 79, 51_719) * 0.35
      const crack = cellularEdge(u, v, 12, 7_319)
      const chip = cellularEdge(u, v, 31, 12_977)
      const pitNoise = tileableValueNoise(u, v, 53, 71_327)
      const pit = smoothstep(0.84, 0.97, pitNoise) *
        smoothstep(0.35, 0.8, grain)

      // R is colour variation, G a signed-height proxy, B aggregate/grain and
      // A cavity. Keeping them independent lets the same bake describe rock,
      // scree and turf without painting one recognisable colour texture over
      // the entire valley.
      const colour = clamp01(0.27 + broad * 0.55 + grain * 0.18 - crack * 0.24)
      const height = clamp01(
        0.28 + broad * 0.5 + grain * 0.12 - crack * 0.32 - chip * 0.08 - pit * 0.2,
      )
      const aggregate = clamp01(grain * 0.76 + chip * 0.36)
      const cavity = clamp01(crack * 0.72 + chip * 0.18 + pit * 0.68)
      const offset = (y * size + x) * 4
      pixels[offset] = Math.round(colour * 255)
      pixels[offset + 1] = Math.round(height * 255)
      pixels[offset + 2] = Math.round(aggregate * 255)
      pixels[offset + 3] = Math.round(cavity * 255)
    }
  }

  return finishTexture(new DataTexture(
    pixels,
    size,
    size,
    RGBAFormat,
    UnsignedByteType,
  ), 'tileable geology detail')
}

/**
 * RG stores a tangent-plane wave slope, B a foam-breakup mask and A the wave
 * height. Two animated samples give the river crossed wave trains with two
 * texture fetches instead of six realtime Perlin evaluations.
 */
export function createWaterDetailTexture(size = 256): DataTexture {
  const height = new Float32Array(size * size)
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const v = y / size
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      const waves =
        Math.sin((u * 5 + v * 2) * Math.PI * 2) * 0.34 +
        Math.sin((u * -3 + v * 7) * Math.PI * 2 + 1.7) * 0.25 +
        Math.sin((u * 11 + v * -5) * Math.PI * 2 + 0.4) * 0.13
      const broad = tileableValueNoise(u, v, 9, 33_439) - 0.5
      height[y * size + x] = waves + broad * 0.42
    }
  }

  const sample = (x: number, y: number) =>
    height[mod(y, size) * size + mod(x, size)]!
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (sample(x + 1, y) - sample(x - 1, y)) * 2.3
      const dz = (sample(x, y + 1) - sample(x, y - 1)) * 2.3
      const foam = tileableValueNoise(x / size, y / size, 23, 84_817)
      const offset = (y * size + x) * 4
      pixels[offset] = Math.round(clamp01(dx * 0.5 + 0.5) * 255)
      pixels[offset + 1] = Math.round(clamp01(dz * 0.5 + 0.5) * 255)
      pixels[offset + 2] = Math.round(foam * 255)
      pixels[offset + 3] = Math.round(clamp01(height[y * size + x]! * 0.34 + 0.5) * 255)
    }
  }

  return finishTexture(new DataTexture(
    pixels,
    size,
    size,
    RGBAFormat,
    UnsignedByteType,
  ), 'tileable water normal detail')
}

function finishTexture(texture: DataTexture, name: string): DataTexture {
  texture.name = name
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
  return texture
}

function tileableValueNoise(
  u: number,
  v: number,
  cells: number,
  seed: number,
): number {
  const px = u * cells
  const py = v * cells
  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  const tx = smoothFraction(px - x0)
  const ty = smoothFraction(py - y0)
  const a = hash(mod(x0, cells), mod(y0, cells), seed)
  const b = hash(mod(x0 + 1, cells), mod(y0, cells), seed)
  const c = hash(mod(x0, cells), mod(y0 + 1, cells), seed)
  const d = hash(mod(x0 + 1, cells), mod(y0 + 1, cells), seed)
  return mix(mix(a, b, tx), mix(c, d, tx), ty)
}

/** 1 at a Voronoi cell boundary, 0 inside a block. */
function cellularEdge(u: number, v: number, cells: number, seed: number): number {
  const px = u * cells
  const py = v * cells
  const baseX = Math.floor(px)
  const baseY = Math.floor(py)
  let nearest = Infinity
  let second = Infinity
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const cellX = baseX + ox
      const cellY = baseY + oy
      const wrappedX = mod(cellX, cells)
      const wrappedY = mod(cellY, cells)
      const fx = cellX + 0.16 + hash(wrappedX, wrappedY, seed) * 0.68
      const fy = cellY + 0.16 + hash(wrappedX, wrappedY, seed + 9_973) * 0.68
      const distance = Math.hypot(px - fx, py - fy)
      if (distance < nearest) {
        second = nearest
        nearest = distance
      } else if (distance < second) {
        second = distance
      }
    }
  }
  return 1 - smoothstep(0.025, 0.14, second - nearest)
}

function hash(x: number, y: number, seed: number): number {
  let value = Math.imul(x, 374_761_393) + Math.imul(y, 668_265_263)
  value = Math.imul(value ^ (value >>> 13) ^ seed, 1_274_126_177)
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295
}

function mod(value: number, range: number): number {
  return ((value % range) + range) % range
}

function smoothFraction(value: number): number {
  return value * value * (3 - 2 * value)
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
