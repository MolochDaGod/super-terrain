/**
 * Tileable scalar noise primitives.
 *
 * Everything here is periodic on an integer lattice, so any field built from
 * these functions wraps seamlessly. The bakes rely on that: a rock material
 * that seams at the tile border is worse than no detail at all once it is
 * repeated across a cliff face.
 */

/** Integer hash (PCG-flavoured); returns a well-distributed uint32. */
export function hashInt(x: number): number {
  let h = x >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return (h ^ (h >>> 16)) >>> 0
}

export function hash2(x: number, y: number, seed: number): number {
  return hashInt(Math.imul(x >>> 0, 0x27d4eb2f) ^ Math.imul(y >>> 0, 0x165667b1) ^ seed)
}

/** Uniform [0,1) from a lattice cell. */
export function rand2(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967296
}

/** Deterministic stream of uniforms, for splatting loops. */
export function makeRng(seed: number): () => number {
  let state = (seed | 0) >>> 0 || 0x9e3779b9
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return hashInt(state) / 4294967296
  }
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function wrap(v: number, period: number): number {
  const m = v % period
  return m < 0 ? m + period : m
}

/**
 * Periodic 2D gradient (Perlin) noise in [-1,1].
 * `period` is in lattice cells; inputs are in the same units.
 */
export function perlin(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = fade(xf)
  const v = fade(yf)

  const grad = (cx: number, cy: number, dx: number, dy: number) => {
    // 8 evenly spaced gradient directions removes the axis bias that a raw
    // hash-to-vector mapping leaves visible on large flat regions.
    const h = hash2(wrap(cx, period), wrap(cy, period), seed) & 7
    const angle = (h * Math.PI) / 4
    return Math.cos(angle) * dx + Math.sin(angle) * dy
  }

  const n00 = grad(xi, yi, xf, yf)
  const n10 = grad(xi + 1, yi, xf - 1, yf)
  const n01 = grad(xi, yi + 1, xf, yf - 1)
  const n11 = grad(xi + 1, yi + 1, xf - 1, yf - 1)
  const nx0 = n00 + u * (n10 - n00)
  const nx1 = n01 + u * (n11 - n01)
  return nx0 + v * (nx1 - nx0)
}

export interface FbmOptions {
  octaves?: number
  /** Amplitude decay per octave. 0.5 is the self-similar default. */
  gain?: number
  /** Frequency growth per octave. Non-integer values break lattice alignment. */
  lacunarity?: number
  /** Anisotropic stretch applied before sampling; models bedding/foliation. */
  stretchX?: number
  stretchY?: number
}

/** Fractal sum of periodic Perlin octaves, normalised to roughly [-1,1]. */
export function fbm(
  x: number,
  y: number,
  period: number,
  seed: number,
  options: FbmOptions = {},
): number {
  const octaves = options.octaves ?? 5
  const gain = options.gain ?? 0.5
  const lacunarity = options.lacunarity ?? 2
  const sx = options.stretchX ?? 1
  const sy = options.stretchY ?? 1
  let amplitude = 1
  let total = 0
  let norm = 0
  let freq = 1
  for (let i = 0; i < octaves; i += 1) {
    // Lacunarity must land on an integer period for the tile to stay seamless,
    // so the period is rounded and the sample frequency follows it exactly.
    const p = Math.max(1, Math.round(period * freq))
    const f = p / period
    total += perlin((x * f) / sx, (y * f) / sy, p, seed + i * 7919) * amplitude
    norm += amplitude
    amplitude *= gain
    freq *= lacunarity
  }
  return total / norm
}

/** Ridged multifractal: sharp crests, rounded troughs. Returns [0,1]. */
export function ridged(
  x: number,
  y: number,
  period: number,
  seed: number,
  options: FbmOptions = {},
): number {
  const octaves = options.octaves ?? 5
  const gain = options.gain ?? 0.5
  const lacunarity = options.lacunarity ?? 2
  const sx = options.stretchX ?? 1
  const sy = options.stretchY ?? 1
  let amplitude = 1
  let total = 0
  let norm = 0
  let freq = 1
  let weight = 1
  for (let i = 0; i < octaves; i += 1) {
    const p = Math.max(1, Math.round(period * freq))
    const f = p / period
    let n = 1 - Math.abs(perlin((x * f) / sx, (y * f) / sy, p, seed + i * 6151))
    n *= n
    // Feeding the previous octave in as a weight is what turns a plain
    // absolute-value sum into a branching ridge network.
    n *= weight
    weight = Math.min(1, n * 2)
    total += n * amplitude
    norm += amplitude
    amplitude *= gain
    freq *= lacunarity
  }
  return total / norm
}

export interface WorleyResult {
  /** Distance to the nearest feature point, in cell units. */
  f1: number
  /** Distance to the second nearest. `f2 - f1` is the classic crack field. */
  f2: number
  /** Cell id of the nearest point, usable as a per-clast random seed. */
  id: number
  /** Offset from the sample to the nearest feature point. */
  dx: number
  dy: number
}

/**
 * Periodic Worley noise with per-cell jitter, anisotropic metric and an
 * optional cell aspect ratio. The aspect ratio is what lets one function
 * describe both equant granite clasts and lensoid schist boudins.
 */
export function worley(
  x: number,
  y: number,
  period: number,
  seed: number,
  jitter = 1,
  aspect = 1,
): WorleyResult {
  const ax = x / aspect
  const xi = Math.floor(ax)
  const yi = Math.floor(y)
  let f1 = 1e9
  let f2 = 1e9
  let id = 0
  let bdx = 0
  let bdy = 0
  const periodX = Math.max(1, Math.round(period / aspect))
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const cx = xi + ox
      const cy = yi + oy
      const h = hash2(wrap(cx, periodX), wrap(cy, period), seed)
      const jx = ((h & 0xffff) / 65536 - 0.5) * jitter + 0.5
      const jy = (((h >>> 16) & 0xffff) / 65536 - 0.5) * jitter + 0.5
      const dx = (cx + jx - ax) * aspect
      const dy = cy + jy - y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < f1) {
        f2 = f1
        f1 = d
        id = h
        bdx = dx
        bdy = dy
      } else if (d < f2) {
        f2 = d
      }
    }
  }
  return { f1, f2, id, dx: bdx, dy: bdy }
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Softly clamped maximum; keeps splat unions from creasing. */
export function smoothMax(a: number, b: number, k: number): number {
  if (k <= 0) return Math.max(a, b)
  const h = clamp01(0.5 + (0.5 * (a - b)) / k)
  return mix(b, a, h) + k * h * (1 - h)
}
