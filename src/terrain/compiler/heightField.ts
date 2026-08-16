import { clamp, lerp, smoothstep } from '../core/bounds'

/**
 * The world's base elevation model.
 *
 * The goal is terrain that is *worth* rendering at high fidelity: ridgelines
 * that recede in overlapping planes, cliff bands with real vertical faces, and
 * quiet meadow floors between them for contrast. That is produced here rather
 * than in the shader, because silhouette and parallax between ridges cannot be
 * faked per-pixel.
 *
 * Composition, in order:
 *   1. a continent-scale mask deciding where mountains are allowed at all
 *   2. domain-warped ridged multifractal for the massif itself
 *   3. billow noise for the rounded foothills and meadow floors
 *   4. valley carving that cuts drainage lines through everything above
 *   5. strata terracing, applied only on steep ground, which is what turns a
 *      smooth slope into stacked cliff bands
 *
 * Every stage is a closed-form function of (x, z) so any point can be evaluated
 * independently: sections compile in parallel, at any LOD, in any order.
 */

export interface HeightFieldSample {
  height: number
  /** 0 on plains, 1 in the high massif. Drives material and detail decisions. */
  massif: number
  /** 0..1 proximity to a carved drainage line. */
  valley: number
  /** Cheap local gradient magnitude estimate; ~1 is a 45-degree slope. */
  steepness: number
}

const MOUNTAIN_AMPLITUDE = 470
const FOOTHILL_AMPLITUDE = 62
const PLAIN_AMPLITUDE = 16
const SEA_LEVEL = -8

export function sampleHeightField(
  x: number,
  z: number,
  seed: number,
): HeightFieldSample {
  // --- 1. where mountains live -----------------------------------------
  // Two very low frequency fields: one selects the massif, one tilts the whole
  // region so the range has a dominant strike direction like a real orogeny.
  const strike = 0.42
  const along = x * Math.cos(strike) + z * Math.sin(strike)
  const across = z * Math.cos(strike) - x * Math.sin(strike)

  const spine = Math.exp(-((across - 120) ** 2) / (2 * 620 ** 2))
  const regional = fbm(x * 0.00028, z * 0.00028, seed + 11, 3, 2.1, 0.5)
  const massif = clamp(
    smoothstep(0.18, 0.78, spine * 0.75 + regional * 0.55 + 0.08),
    0,
    1,
  )

  // --- 2. the massif ----------------------------------------------------
  // Warping the sample point before the ridge stack is what produces bent,
  // interlocking ridgelines instead of a regular grid of cones.
  const warpX = fbm(x * 0.0011, z * 0.0011, seed + 71, 3, 2.2, 0.5) * 240
  const warpZ = fbm(x * 0.0011 + 5.7, z * 0.0011 - 3.1, seed + 73, 3, 2.2, 0.5) * 240
  const ridge = ridgedMultifractal(
    (x + warpX) * 0.00085,
    (z + warpZ) * 0.00085,
    seed + 101,
    9,
  )
  // Sharpening the ridge profile raises the peaks and flattens the basins,
  // which reads as glacial relief rather than as noise.
  const mountains = Math.pow(ridge, 1.55) * MOUNTAIN_AMPLITUDE * massif

  // --- 3. foothills and plains -----------------------------------------
  const foothills =
    billow(x * 0.0034, z * 0.0034, seed + 211, 4) *
    FOOTHILL_AMPLITUDE *
    (0.35 + massif * 0.9)
  const plains =
    fbm(x * 0.0062, z * 0.0062, seed + 307, 4, 2.15, 0.52) * PLAIN_AMPLITUDE

  let height = SEA_LEVEL + mountains + foothills + plains + along * 0.004

  // --- 4. valleys -------------------------------------------------------
  // A second ridge field, inverted, used as a drainage network. Its channels
  // cut deepest where the terrain is highest, mimicking headward erosion.
  const drainage = ridgedMultifractal(
    (x - warpZ * 0.4) * 0.00062,
    (z + warpX * 0.4) * 0.00062,
    seed + 401,
    5,
  )
  const valley = clamp(smoothstep(0.62, 0.98, 1 - drainage), 0, 1)
  const cutDepth = (26 + massif * 120) * valley
  height -= cutDepth

  // Flatten the valley floor so rivers and meadows have somewhere to sit.
  const floor = SEA_LEVEL + 6 + massif * 40
  if (valley > 0.55) {
    const flatten = smoothstep(0.55, 0.95, valley) * 0.65
    height = lerp(height, Math.min(height, floor + valley * 12), flatten)
  }

  // --- 5. strata terracing ---------------------------------------------
  const steepness = estimateSteepness(x, z, seed, massif)
  const terraced = applyStrata(height, x, z, seed, massif, steepness)

  return { height: terraced, massif, valley, steepness }
}

/** Convenience wrapper for callers that only need elevation. */
export function sampleHeight(x: number, z: number, seed: number): number {
  return sampleHeightField(x, z, seed).height
}

/**
 * Local gradient magnitude from a deliberately coarse stand-in for the full
 * height stack. Terracing only needs to know "is this a face or a bench", and
 * finite-differencing the real field would triple the cost of every vertex.
 */
function estimateSteepness(
  x: number,
  z: number,
  seed: number,
  massif: number,
): number {
  if (massif < 0.05) return 0
  const delta = 9
  const centre = coarseRelief(x, z, seed)
  const dx = coarseRelief(x + delta, z, seed) - centre
  const dz = coarseRelief(x, z + delta, seed) - centre
  return Math.hypot(dx, dz) / delta
}

function coarseRelief(x: number, z: number, seed: number): number {
  const warpX = fbm(x * 0.0011, z * 0.0011, seed + 71, 2, 2.2, 0.5) * 240
  const warpZ = fbm(x * 0.0011 + 5.7, z * 0.0011 - 3.1, seed + 73, 2, 2.2, 0.5) * 240
  const ridge = ridgedMultifractal(
    (x + warpX) * 0.00085,
    (z + warpZ) * 0.00085,
    seed + 101,
    6,
  )
  return Math.pow(ridge, 1.55) * MOUNTAIN_AMPLITUDE
}

/**
 * Quantises elevation towards discrete bedding planes, blended in by how steep
 * the ground is. This is the difference between strata and contour lines: on a
 * bench the surface keeps its smooth profile, and only faces steep enough to
 * expose the rock gain the ledge-and-riser profile. The band phase is also
 * perturbed horizontally so ledges break up instead of ringing the whole massif
 * at one elevation.
 */
function applyStrata(
  height: number,
  x: number,
  z: number,
  seed: number,
  massif: number,
  steepness: number,
): number {
  const exposure = smoothstep(0.62, 1.5, steepness) * massif
  if (exposure < 0.02) return height
  const bandHeight = 21 + fbm(x * 0.0009, z * 0.0009, seed + 503, 2, 2, 0.5) * 9
  // Tilt the bedding so strata are not level, and jitter the phase so a single
  // bedding plane does not survive all the way around the mountain.
  const tilt = x * 0.041 + z * 0.023
  const jitter = fbm(x * 0.0021, z * 0.0021, seed + 601, 3, 2.1, 0.5) * bandHeight * 0.55
  const local = height + tilt + jitter
  const band = local / bandHeight
  const index = Math.floor(band)
  const fraction = band - index
  // Hard bands alternate with soft ones, so ledges vary in prominence.
  const hardness = 0.5 + fbm(index * 0.7, index * 1.3, seed + 701, 2, 2, 0.5) * 0.5
  // A narrow transition band is what makes the riser near-vertical; widening it
  // turns the same code into gentle steps.
  const stepped =
    (index + smoothstep(0.46 - hardness * 0.1, 0.54 + hardness * 0.14, fraction)) *
      bandHeight -
    tilt -
    jitter
  return lerp(height, stepped, 0.6 * exposure * hardness)
}

function ridgedMultifractal(
  x: number,
  z: number,
  seed: number,
  octaves: number,
): number {
  let sum = 0
  let amplitude = 0.52
  let frequency = 1
  let weight = 1
  let total = 0
  for (let octave = 0; octave < octaves; octave += 1) {
    let signal = 1 - Math.abs(valueNoise(x * frequency, z * frequency, seed + octave * 37) * 2 - 1)
    signal *= signal
    // Weighting each octave by the previous one concentrates detail on the
    // ridges and leaves the flanks smooth — the defining trait of the form.
    signal *= weight
    weight = clamp(signal * 2.2, 0, 1)
    sum += signal * amplitude
    total += amplitude
    amplitude *= 0.52
    frequency *= 2.07
  }
  return clamp(sum / total, 0, 1)
}

function billow(x: number, z: number, seed: number, octaves: number): number {
  let sum = 0
  let amplitude = 0.5
  let frequency = 1
  let total = 0
  for (let octave = 0; octave < octaves; octave += 1) {
    const signal = Math.abs(valueNoise(x * frequency, z * frequency, seed + octave * 53) * 2 - 1)
    sum += signal * amplitude
    total += amplitude
    amplitude *= 0.5
    frequency *= 2.03
  }
  return sum / total
}

function fbm(
  x: number,
  z: number,
  seed: number,
  octaves: number,
  lacunarity: number,
  gain: number,
): number {
  let sum = 0
  let amplitude = 0.5
  let frequency = 1
  let total = 0
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += (valueNoise(x * frequency, z * frequency, seed + octave * 17) * 2 - 1) * amplitude
    total += amplitude
    amplitude *= gain
    frequency *= lacunarity
  }
  return sum / total
}

function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x)
  const z0 = Math.floor(z)
  const tx = smoothFraction(x - x0)
  const tz = smoothFraction(z - z0)
  const a = hash2(x0, z0, seed)
  const b = hash2(x0 + 1, z0, seed)
  const c = hash2(x0, z0 + 1, seed)
  const d = hash2(x0 + 1, z0 + 1, seed)
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz)
}

function smoothFraction(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10)
}

function hash2(x: number, z: number, seed: number): number {
  let value = Math.imul(x, 374_761_393) + Math.imul(z, 668_265_263)
  value = (value ^ (value >>> 13)) + Math.imul(seed, 1_443_053)
  value = Math.imul(value ^ (value >>> 16), 1_274_126_177)
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295
}
