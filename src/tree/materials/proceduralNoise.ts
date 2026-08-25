/** Shared deterministic noise for the in-memory texture bakes. */

export function fbm(x: number, y: number, seed: number, octaves: number): number {
  let value = 0
  let amplitude = 0.5
  let normalization = 0
  for (let octave = 0; octave < octaves; octave += 1) {
    value += valueNoise(x, y, seed + octave * 1013) * amplitude
    normalization += amplitude
    x = x * 2.03 + 17.1
    y = y * 2.01 - 9.7
    amplitude *= 0.5
  }
  return value / normalization
}

export function valueNoise(x: number, y: number, seed: number): number {
  const left = Math.floor(x)
  const top = Math.floor(y)
  const tx = fade(x - left)
  const ty = fade(y - top)
  const a = hash2(left, top, seed)
  const b = hash2(left + 1, top, seed)
  const c = hash2(left, top + 1, seed)
  const d = hash2(left + 1, top + 1, seed)
  return mix(mix(a, b, tx), mix(c, d, tx), ty)
}

/**
 * Value noise on a lattice that wraps every `periodX` by `periodY` cells.
 *
 * A tiling material has to be built from tiling *primitives*. Plain value noise
 * has no period at all, so a texture made from it meets itself at the tile
 * boundary with two unrelated fields butted together — a hard band straight
 * across the surface at every repeat. On a trunk, where the texture wraps
 * several times up the bole, that band is the loudest artefact on the model.
 *
 * Coordinates arrive pre-scaled by their frequency, and the period is that same
 * frequency, so a caller only has to keep its frequencies whole.
 */
export function tiledValueNoise(
  x: number,
  y: number,
  seed: number,
  periodX: number,
  periodY: number,
): number {
  const left = Math.floor(x)
  const top = Math.floor(y)
  const tx = fade(x - left)
  const ty = fade(y - top)
  const x0 = positiveModulo(left, periodX)
  const x1 = positiveModulo(left + 1, periodX)
  const y0 = positiveModulo(top, periodY)
  const y1 = positiveModulo(top + 1, periodY)
  return mix(
    mix(hash2(x0, y0, seed), hash2(x1, y0, seed), tx),
    mix(hash2(x0, y1, seed), hash2(x1, y1, seed), tx),
    ty,
  )
}

/**
 * {@link tiledValueNoise} together with its analytic gradient, into `out`.
 *
 * The crease field needs the gradient at every texel to normalise its fold
 * into a distance, and taking it by finite differences costs three full noise
 * evaluations — twelve hashes — where the bilinear form gives it exactly from
 * the four corners already fetched. On a two-megapixel bake across five
 * octaves that difference is most of a minute.
 *
 * Writes `[value, d/dx, d/dy]`; the derivatives are with respect to the cell
 * coordinates passed in, not to uv.
 */
export function tiledValueNoiseGradient(
  x: number,
  y: number,
  seed: number,
  periodX: number,
  periodY: number,
  out: Float64Array,
): void {
  const left = Math.floor(x)
  const top = Math.floor(y)
  const fx = x - left
  const fy = y - top
  const tx = fade(fx)
  const ty = fade(fy)
  // d/dt of t*t*(3 - 2t).
  const dtx = 6 * fx * (1 - fx)
  const dty = 6 * fy * (1 - fy)
  const x0 = positiveModulo(left, periodX)
  const x1 = positiveModulo(left + 1, periodX)
  const y0 = positiveModulo(top, periodY)
  const y1 = positiveModulo(top + 1, periodY)
  const c00 = hash2(x0, y0, seed)
  const c10 = hash2(x1, y0, seed)
  const c01 = hash2(x0, y1, seed)
  const c11 = hash2(x1, y1, seed)
  const bottom = c00 + (c10 - c00) * tx
  const topRow = c01 + (c11 - c01) * tx
  out[0] = bottom + (topRow - bottom) * ty
  out[1] = ((c10 - c00) + ((c11 - c01) - (c10 - c00)) * ty) * dtx
  out[2] = (topRow - bottom) * dty
}

/** Octaves of {@link tiledValueNoise}; each doubles both frequency and period. */
export function tiledFbm(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  periodX: number,
  periodY: number,
): number {
  let value = 0
  let amplitude = 0.5
  let normalization = 0
  let currentX = x
  let currentY = y
  let spanX = periodX
  let spanY = periodY
  for (let octave = 0; octave < octaves; octave += 1) {
    value += tiledValueNoise(currentX, currentY, seed + octave * 1013, spanX, spanY) *
      amplitude
    normalization += amplitude
    currentX *= 2
    currentY *= 2
    spanX *= 2
    spanY *= 2
    amplitude *= 0.5
  }
  return value / normalization
}

/** Distance to a wrapped Voronoi cell edge; zero is a natural plate fissure. */
export function cellularBorder(
  x: number,
  y: number,
  seed: number,
  wrapX: number,
  wrapY: number,
  /**
   * How far a feature point may stray inside its cell, in cell units. Full
   * jitter on a strongly anisotropic grid makes borders zigzag across the short
   * axis, because the offset is large next to the cell's own width; damping it
   * keeps long cells reading as long, and the domain warp supplies the
   * meandering instead.
   */
  jitter = 0.72,
): number {
  const cellX = Math.floor(x)
  const cellY = Math.floor(y)
  let nearest = Infinity
  let secondNearest = Infinity
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const sourceX = cellX + offsetX
      const sourceY = cellY + offsetY
      const wrappedX = positiveModulo(sourceX, wrapX)
      const wrappedY = positiveModulo(sourceY, wrapY)
      const centre = (1 - jitter) * 0.5
      const featureX = sourceX + centre + hash2(wrappedX, wrappedY, seed) * jitter
      const featureY = sourceY + centre +
        hash2(wrappedX, wrappedY, seed + 4099) * jitter
      const distanceSquared = (featureX - x) ** 2 + (featureY - y) ** 2
      if (distanceSquared < nearest) {
        secondNearest = nearest
        nearest = distanceSquared
      } else if (distanceSquared < secondNearest) {
        secondNearest = distanceSquared
      }
    }
  }
  return Math.sqrt(secondNearest) - Math.sqrt(nearest)
}

export function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus
}

export function hash2(x: number, y: number, seed: number): number {
  let value = seed | 0
  value ^= Math.imul(x, 0x45d9f3b)
  value ^= Math.imul(y, 0x119de1f3)
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d)
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295
}

export function fade(value: number): number {
  return value * value * (3 - 2 * value)
}

export function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}

export function smooth01(value: number): number {
  const clamped = clamp01(value)
  return clamped * clamped * (3 - 2 * clamped)
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function byte(value: number): number {
  return Math.round(clamp01(value) * 255)
}

/**
 * Distance to the nearest boundary in a jittered one-dimensional cell field,
 * plus the identity of the cell it falls in.
 *
 * Oak bark is columnar: long vertical furrows of varying spacing and width,
 * with only occasional horizontal links between them. A two-dimensional cell
 * network cannot express that — its borders are equally strong in both axes, so
 * it always reads as reptile skin. Splitting the two axes apart lets the
 * vertical structure dominate and the cross-links be added sparsely on top,
 * which is the actual anatomy.
 */
export function columnBorder(
  x: number,
  seed: number,
  wrap: number,
): { border: number; cell: number } {
  let nearest = Infinity
  let secondNearest = Infinity
  let nearestCell = 0
  for (let offset = -1; offset <= 1; offset += 1) {
    const source = Math.floor(x) + offset
    const wrapped = positiveModulo(source, wrap)
    const feature = source + 0.2 + hash2(wrapped, 0, seed) * 0.6
    const distance = Math.abs(feature - x)
    if (distance < nearest) {
      secondNearest = nearest
      nearest = distance
      nearestCell = wrapped
    } else if (distance < secondNearest) {
      secondNearest = distance
    }
  }
  return { border: (secondNearest - nearest) * 0.5, cell: nearestCell }
}
