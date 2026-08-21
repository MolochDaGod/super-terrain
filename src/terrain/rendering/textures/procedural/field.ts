import { clamp01 } from './noise'

/**
 * A square, toroidally wrapped Float32 scalar field.
 *
 * Every operation in this module preserves the wrap, so a field can be
 * filtered, eroded and differentiated without ever growing a seam.
 */
export interface Field {
  readonly size: number
  readonly data: Float32Array
}

export function createField(size: number, fill = 0): Field {
  const data = new Float32Array(size * size)
  if (fill !== 0) data.fill(fill)
  return { size, data }
}

export function cloneField(field: Field): Field {
  return { size: field.size, data: Float32Array.from(field.data) }
}

/**
 * Lookup table mapping an offset coordinate in [-size, 2*size) to its wrapped
 * value. The inner loops of the erosion and occlusion passes address hundreds
 * of millions of neighbours; replacing two modulo operations per access with
 * one array read is the difference between a bake that fits in a worker
 * startup and one that does not.
 */
export function createWrapTable(size: number): Int32Array {
  const table = new Int32Array(size * 3)
  for (let i = 0; i < size * 3; i += 1) table[i] = (i - size) % size
  for (let i = 0; i < size * 3; i += 1) if (table[i]! < 0) table[i]! += size
  return table
}

export function wrapIndex(v: number, size: number): number {
  // Floored, not just wrapped: a fractional coordinate would index between
  // elements and read `undefined`, which propagates as NaN through every
  // later stage and is invisible until a whole map comes out black.
  const m = Math.floor(v) % size
  return m < 0 ? m + size : m
}

export function at(field: Field, x: number, y: number): number {
  return field.data[wrapIndex(y, field.size) * field.size + wrapIndex(x, field.size)]!
}

export function setAt(field: Field, x: number, y: number, value: number): void {
  field.data[wrapIndex(y, field.size) * field.size + wrapIndex(x, field.size)] = value
}

export function addAt(field: Field, x: number, y: number, value: number): void {
  field.data[wrapIndex(y, field.size) * field.size + wrapIndex(x, field.size)]! += value
}

/** Bilinear sample in pixel coordinates. */
export function sampleBilinear(field: Field, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const a = at(field, x0, y0)
  const b = at(field, x0 + 1, y0)
  const c = at(field, x0, y0 + 1)
  const d = at(field, x0 + 1, y0 + 1)
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
}

/** Fills a field from a normalised-uv generator. */
export function fillField(
  size: number,
  generate: (u: number, v: number, x: number, y: number) => number,
): Field {
  const field = createField(size)
  for (let y = 0; y < size; y += 1) {
    const v = y / size
    for (let x = 0; x < size; x += 1) {
      field.data[y * size + x] = generate(x / size, v, x, y)
    }
  }
  return field
}

export function mapField(field: Field, fn: (value: number, index: number) => number): Field {
  const out = createField(field.size)
  for (let i = 0; i < field.data.length; i += 1) out.data[i] = fn(field.data[i]!, i)
  return out
}

export function fieldRange(field: Field): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < field.data.length; i += 1) {
    const v = field.data[i]!
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

/** Rescales to [0,1] using the actual extent. */
export function normalizeField(field: Field): Field {
  const { min, max } = fieldRange(field)
  const span = max - min || 1
  return mapField(field, (v) => (v - min) / span)
}

/**
 * Rescales so that `lowQuantile` maps to 0 and `highQuantile` to 1.
 * Photographic scans almost never use their full range at the extremes; a
 * percentile stretch matches their contrast far better than a min/max one.
 */
export function stretchField(field: Field, lowQuantile = 0.005, highQuantile = 0.995): Field {
  const sorted = Float32Array.from(field.data).sort()
  const lo = sorted[Math.floor(clamp01(lowQuantile) * (sorted.length - 1))]!
  const hi = sorted[Math.floor(clamp01(highQuantile) * (sorted.length - 1))]!
  const span = hi - lo || 1
  return mapField(field, (v) => clamp01((v - lo) / span))
}

/** Separable box blur, repeated to approximate a Gaussian. */
export function blurField(field: Field, radius: number, passes = 3): Field {
  if (radius < 0.5) return cloneField(field)
  const size = field.size
  const r = Math.max(1, Math.round(radius))
  let src = Float32Array.from(field.data)
  let dst = new Float32Array(size * size)
  const inv = 1 / (2 * r + 1)
  for (let pass = 0; pass < passes; pass += 1) {
    for (let y = 0; y < size; y += 1) {
      const row = y * size
      let sum = 0
      for (let k = -r; k <= r; k += 1) sum += src[row + wrapIndex(k, size)]!
      for (let x = 0; x < size; x += 1) {
        dst[row + x] = sum * inv
        sum += src[row + wrapIndex(x + r + 1, size)]! - src[row + wrapIndex(x - r, size)]!
      }
    }
    const swap = src
    src = dst
    dst = swap
    for (let x = 0; x < size; x += 1) {
      let sum = 0
      for (let k = -r; k <= r; k += 1) sum += src[wrapIndex(k, size) * size + x]!
      for (let y = 0; y < size; y += 1) {
        dst[y * size + x] = sum * inv
        sum +=
          src[wrapIndex(y + r + 1, size) * size + x]! - src[wrapIndex(y - r, size) * size + x]!
      }
    }
    const swap2 = src
    src = dst
    dst = swap2
  }
  return { size, data: src }
}

/** field - blur(field): the band-limited detail at a given scale. */
export function highPass(field: Field, radius: number): Field {
  const low = blurField(field, radius)
  const out = createField(field.size)
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = field.data[i]! - low.data[i]!
  return out
}

export function addFields(a: Field, b: Field, scale = 1): Field {
  const out = createField(a.size)
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = a.data[i]! + b.data[i]! * scale
  return out
}

/** Displaces the field by a vector field, in pixels. */
export function warpField(field: Field, dx: Field, dy: Field, amount: number): Field {
  const size = field.size
  const out = createField(size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x
      out.data[i] = sampleBilinear(field, x + dx.data[i]! * amount, y + dy.data[i]! * amount)
    }
  }
  return out
}

/** Central-difference gradient, in units per pixel. */
export function gradient(field: Field, x: number, y: number): { gx: number; gy: number } {
  return {
    gx: (at(field, x + 1, y) - at(field, x - 1, y)) * 0.5,
    gy: (at(field, x, y + 1) - at(field, x, y - 1)) * 0.5,
  }
}

/**
 * Mean curvature (the Laplacian, sign-flipped so ridges read positive).
 * Curvature is the single strongest cue for where a real rock face is
 * bleached, lichened or silted, so it gets its own well-conditioned pass.
 */
export function curvatureField(field: Field, radius = 2): Field {
  const smooth = blurField(field, radius)
  const size = field.size
  const out = createField(size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const c = at(smooth, x, y)
      const lap =
        at(smooth, x + 1, y) +
        at(smooth, x - 1, y) +
        at(smooth, x, y + 1) +
        at(smooth, x, y - 1) -
        4 * c
      out.data[y * size + x] = -lap
    }
  }
  return out
}

/** Slope magnitude in units per pixel. */
export function slopeField(field: Field): Field {
  const size = field.size
  const out = createField(size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const g = gradient(field, x, y)
      out.data[y * size + x] = Math.hypot(g.gx, g.gy)
    }
  }
  return out
}

/** Bilinear upsample of a lower-resolution field, keeping the wrap. */
export function resampleField(field: Field, size: number): Field {
  if (field.size === size) return cloneField(field)
  const scale = field.size / size
  const out = createField(size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      out.data[y * size + x] = sampleBilinear(field, (x + 0.5) * scale - 0.5, (y + 0.5) * scale - 0.5)
    }
  }
  return out
}
