import { at, type Field } from './field'
import { clamp01 } from './noise'

/**
 * Encodes a height field as an OpenGL-convention tangent-space normal map.
 *
 * The Sobel kernel is used rather than a central difference because the
 * bakes are viewed at close range: a 3x3 weighted derivative is markedly less
 * prone to the diagonal stair-stepping that shows up on lit shallow slopes.
 */
export function heightToNormal(height: Field, strength: number): Uint8Array {
  const size = height.size
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const h00 = at(height, x - 1, y - 1)
      const h10 = at(height, x, y - 1)
      const h20 = at(height, x + 1, y - 1)
      const h01 = at(height, x - 1, y)
      const h21 = at(height, x + 1, y)
      const h02 = at(height, x - 1, y + 1)
      const h12 = at(height, x, y + 1)
      const h22 = at(height, x + 1, y + 1)
      const gx = h00 + 2 * h01 + h02 - (h20 + 2 * h21 + h22)
      const gy = h00 + 2 * h10 + h20 - (h02 + 2 * h12 + h22)
      let nx = gx * strength
      let ny = gy * strength
      let nz = 1
      const len = Math.hypot(nx, ny, nz)
      nx /= len
      ny /= len
      nz /= len
      const offset = (y * size + x) * 4
      out[offset] = Math.round((nx * 0.5 + 0.5) * 255)
      out[offset + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      out[offset + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      out[offset + 3] = 255
    }
  }
  return out
}

/** Linear [0,1] to 8-bit sRGB. */
export function encodeSrgb(value: number): number {
  const v = clamp01(value)
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.round(s * 255)
}

export function encodeLinear(value: number): number {
  return Math.round(clamp01(value) * 255)
}

/** Packs AO / roughness / metalness into one RGB texture, ARM convention. */
/**
 * Occlusion, roughness, metalness — and height in the alpha.
 *
 * Height used to be its own RGBA map with the same value written into all four
 * channels, which cost a whole texture and, far more expensively, a whole
 * *sampler* to carry eight bits. WebGPU guarantees only sixteen samplers per
 * shader stage and this adapter offers exactly sixteen, so the terrain material
 * sat on the limit and the next surface detail anyone wanted was unaffordable.
 * Two surfaces each dropping a redundant map is two samplers back.
 *
 * Alpha is the right home for it: the ARM map is already sampled everywhere the
 * height is wanted, at the same UV, from the same bake, so the fetch is free and
 * the two can never fall out of correlation.
 */
export function packArm(
  ao: Field,
  roughness: Field,
  metalness: Field,
  height: Field,
): Uint8Array {
  const size = ao.size
  const out = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = encodeLinear(ao.data[i]!)
    out[i * 4 + 1] = encodeLinear(roughness.data[i]!)
    out[i * 4 + 2] = encodeLinear(metalness.data[i]!)
    out[i * 4 + 3] = encodeLinear(height.data[i]!)
  }
  return out
}

export interface Rgb {
  r: number
  g: number
  b: number
}

/** Linear-space colour mix. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  }
}

export function scaleRgb(c: Rgb, s: number): Rgb {
  return { r: c.r * s, g: c.g * s, b: c.b * s }
}

/** Converts an sRGB hex literal to a linear-space triple. */
export function srgbHex(hex: number): Rgb {
  const toLinear = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return {
    r: toLinear((hex >> 16) & 0xff),
    g: toLinear((hex >> 8) & 0xff),
    b: toLinear(hex & 0xff),
  }
}
