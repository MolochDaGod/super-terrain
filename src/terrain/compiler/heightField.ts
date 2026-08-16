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
  /** 0..1 proximity to a carved drainage line; the mask the carving used. */
  valley: number
  /** 0..1 catchment concentration: where water runs, carved or not. */
  flow: number
  /** Cheap local gradient magnitude estimate; ~1 is a 45-degree slope. */
  steepness: number
  /** The bedding attitude used to terrace this point. */
  bedding: Bedding
}

/**
 * Attitude of the local bedding planes.
 *
 * Sedimentary rock is a stack of parallel planes cutting *through* the rock
 * mass. They are not a function of elevation, and that distinction is the
 * entire difference between strata and a contour map: because the planes are
 * tilted and the topography is not, the outcrop trace of a bed cuts obliquely
 * across a slope, widens on gentle ground, narrows on a face, and vanishes
 * altogether where a hillside happens to lie parallel to the bedding.
 *
 * One model produces this, and both the mesh terracing and the material read
 * from it, so the geometric ledge and the shaded band are the same bed.
 */
export interface Bedding {
  /** Unit normal of the bedding planes; `y` is `cos(dip)`. */
  normalX: number
  normalY: number
  normalZ: number
  /** Metres of true thickness between successive beds. */
  thickness: number
  /** 0..1 how strongly bedding is expressed at the surface in this region. */
  expression: number
}

/** Dip range in radians. Below ~10 degrees the outcrop trace is a contour. */
const MIN_DIP = 0.22
const MAX_DIP = 0.62

/**
 * Bedding attitude at a point. Dip and strike drift over kilometres — the scale
 * of a fold limb — so one massif reads as a single tilted block rather than as
 * a pattern applied per-pixel.
 */
export function sampleBedding(x: number, z: number, seed: number): Bedding {
  const dip =
    MIN_DIP +
    (fbm(x * 0.00042, z * 0.00042, seed + 811, 2, 2.1, 0.5) * 0.5 + 0.5) *
      (MAX_DIP - MIN_DIP)
  // The strike follows the range's own trend, as it does in a real orogeny
  // where the folding and the topography share a cause.
  const azimuth =
    0.42 +
    Math.PI * 0.5 +
    fbm(x * 0.00031, z * 0.00031, seed + 823, 2, 2.1, 0.5) * 1.1
  const sinDip = Math.sin(dip)
  const thickness =
    9 + (fbm(x * 0.00075, z * 0.00075, seed + 839, 2, 2, 0.5) * 0.5 + 0.5) * 17
  // Only part of a range is well-bedded at the surface. Elsewhere the rock is
  // massive, or the beds are too thin to resolve, or the face is a fresh
  // fracture across them. Without this gate the banding rings every summit.
  const expression = clamp(
    smoothstep(
      0.44,
      0.82,
      fbm(x * 0.00095, z * 0.00095, seed + 857, 3, 2.1, 0.5) * 0.5 + 0.5,
    ),
    0,
    1,
  )
  return {
    normalX: Math.sin(azimuth) * sinDip,
    normalY: Math.cos(dip),
    normalZ: Math.cos(azimuth) * sinDip,
    thickness,
    expression,
  }
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

  // Water does not only run where the valley is deep enough to have been cut.
  // It runs down every hollow, and the wet rock, the moss and the green strip
  // that marks a runnel are visible long before there is a gorge. `valley` is
  // the carving mask and is deliberately narrow; this is the catchment the
  // material should read, and it reaches into every tributary above it.
  // Concentration falls off sharply away from a channel: most of a hillside is
  // interfluve that sheds water rather than carrying it. Widening this until
  // the tributaries appear also makes every face wet, which reads as polished
  // mud — so the band stays narrow and the tail is what reaches upslope.
  const flow = clamp(smoothstep(0.5, 0.95, 1 - drainage), 0, 1) ** 1.4

  // Flatten the valley floor so rivers and meadows have somewhere to sit.
  const floor = SEA_LEVEL + 6 + massif * 40
  if (valley > 0.55) {
    const flatten = smoothstep(0.55, 0.95, valley) * 0.65
    height = lerp(height, Math.min(height, floor + valley * 12), flatten)
  }

  // --- 5. strata terracing ---------------------------------------------
  const steepness = estimateSteepness(x, z, seed, massif)
  const bedding = sampleBedding(x, z, seed)
  const terraced = applyStrata(height, x, z, seed, massif, steepness, bedding)

  return { height: terraced, massif, valley, flow, steepness, bedding }
}

/**
 * Memoised whole-sample access.
 *
 * Meshing evaluates the height at every vertex and the material pass then needs
 * the terrain-derived fields at the same points. The stack behind these is nine
 * octaves of ridged multifractal plus a drainage network, so recomputing it
 * would roughly double compile time; a bounded map keyed on the exact
 * coordinates the mesher used turns the second pass into a lookup.
 */
const sampleCache = new Map<string, HeightFieldSample>()
const SAMPLE_CACHE_LIMIT = 300_000

export function sampleHeightFieldCached(
  x: number,
  z: number,
  seed: number,
): HeightFieldSample {
  const key = `${x}:${z}:${seed}`
  const hit = sampleCache.get(key)
  if (hit) return hit
  const sample = sampleHeightField(x, z, seed)
  // Compiles arrive section by section, so the oldest entries are the least
  // likely to be asked for again. Clearing wholesale beats evicting one by one.
  if (sampleCache.size >= SAMPLE_CACHE_LIMIT) sampleCache.clear()
  sampleCache.set(key, sample)
  return sample
}

/** Convenience wrapper for callers that only need elevation. */
export function sampleHeight(x: number, z: number, seed: number): number {
  return sampleHeightFieldCached(x, z, seed).height
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
 * Cuts ledge-and-riser profiles into faces where resistant beds outcrop.
 *
 * The surface is pulled towards the nearest *bedding plane*, measured along the
 * bedding normal, not towards the nearest elevation. Because the planes are
 * tilted 13-36 degrees and the topography is not, the resulting ledges climb
 * across a slope and die out where the hillside turns to face along the dip —
 * the behaviour that reads as geology. Quantising elevation instead, however
 * finely it is jittered, can only ever produce contours.
 *
 * Terracing is also confined to genuinely steep, well-bedded ground: a bench or
 * a meadow keeps its smooth profile, so the ledges belong to the cliffs that
 * carry them rather than ringing the whole massif.
 */
function applyStrata(
  height: number,
  x: number,
  z: number,
  seed: number,
  massif: number,
  steepness: number,
  bedding: Bedding,
): number {
  const exposure =
    smoothstep(0.85, 1.9, steepness) * massif * bedding.expression
  if (exposure < 0.02) return height

  // Distance from the origin along the bedding normal, in bed counts. The
  // horizontal terms carry sin(dip), which is what makes the trace oblique.
  const along =
    x * bedding.normalX + height * bedding.normalY + z * bedding.normalZ
  const band = along / bedding.thickness
  const index = Math.floor(band)
  const fraction = band - index
  // Beds alternate resistant and weak, so ledges vary in prominence instead of
  // arriving as a regular comb.
  const hardness = 0.5 + fbm(index * 0.7, index * 1.3, seed + 701, 2, 2, 0.5) * 0.5
  // A narrow transition is what makes the riser near-vertical; widening it
  // turns the same code into gentle steps.
  const snapped =
    index + smoothstep(0.44 - hardness * 0.12, 0.56 + hardness * 0.16, fraction)
  // Convert the correction back to a vertical displacement. Dividing by the
  // normal's vertical component moves the point onto the plane along Y, which
  // is the only axis a heightfield may move on.
  const shift = ((snapped - band) * bedding.thickness) / bedding.normalY
  return height + shift * clamp(0.55 * exposure * hardness, 0, 1)
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
