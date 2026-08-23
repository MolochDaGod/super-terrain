import { clamp, lerp, smoothstep } from '../core/bounds'
import { WATER_LEVEL } from './climate'

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
  /**
   * 0..1 regional climate: 0 is temperate alpine, 1 is true desert.
   *
   * This is the biome selector. It is a property of *where* a point is in the
   * range rather than of what the ground there is made of, so it varies over
   * kilometres and never over metres, and every material decision downstream
   * reads it as a slow blend rather than as a switch.
   */
  aridity: number
  /**
   * 0..1 dune-sea strength: how completely wind-blown sand has taken over the
   * surface here. Distinct from `aridity` because most of a desert is not an
   * erg — sand needs somewhere flat and low to collect before it can build.
   */
  erg: number
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

/**
 * Which landform model the world is built from.
 *
 * `natural` is the full composition documented above. `flat` replaces stages
 * one through five with a near-level plain, which is what "start from nothing"
 * has to mean for a terrain editor: a surface with enough roughness to catch
 * light and to show a brush working, and no landforms the user did not put
 * there. It is deliberately not a separate code path anywhere downstream —
 * materials, strata and water all read the same sample fields either way.
 */
export type WorldProfile = 'natural' | 'flat'

let worldProfile: WorldProfile = 'natural'

/**
 * Set once per world, on the main thread and inside every compile worker.
 *
 * It is module state rather than a parameter because the height field is
 * sampled from roughly forty call sites across meshing, materials, water and
 * rock planting, and threading a world-lifetime constant through all of them
 * would say nothing that this does not.
 */
export function setWorldProfile(profile: WorldProfile): void {
  if (profile === worldProfile) return
  worldProfile = profile
  clearSampleCache()
}

export function getWorldProfile(): WorldProfile {
  return worldProfile
}

/** Elevation the flat profile sits at: above the water level, so a new world is dry. */
export const FLAT_GROUND_LEVEL = WATER_LEVEL + 12

function sampleFlatField(x: number, z: number, seed: number): HeightFieldSample {
  // A couple of metres of very broad undulation plus centimetre grain. Without
  // it the plain shades as one flat colour and neither the sun angle nor an
  // early brush stroke is legible against it.
  const swell = fbm(x * 0.0009, z * 0.0009, seed + 61, 2, 2.1, 0.5) * 2.4
  const grain = fbm(x * 0.021, z * 0.021, seed + 67, 2, 2.1, 0.5) * 0.35
  return {
    height: FLAT_GROUND_LEVEL + swell + grain,
    massif: 0,
    valley: 0,
    flow: 0,
    aridity: 0.25,
    erg: 0,
    steepness: 0.02,
    bedding: sampleBedding(x, z, seed),
  }
}

export function sampleHeightField(
  x: number,
  z: number,
  seed: number,
): HeightFieldSample {
  if (worldProfile === 'flat') return sampleFlatField(x, z, seed)

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

  // --- 1b. climate ------------------------------------------------------
  // Aridity is a consequence of the range rather than an independent noise
  // blob laid over it. Moist air arrives across the strike, is lifted over the
  // spine and drops its water on the windward side; what continues over the
  // top arrives dry. Biasing the climate field by `across` is what makes the
  // desert margin run *parallel to the mountains*, which is the single
  // strongest cue that a desert is where it is for a reason. A thresholded
  // noise field can place sand next to snow with a straight face; this cannot.
  //
  // The regional term is what keeps it from being a clean half-world split:
  // at ~4.8 km it puts two or three climate provinces across the world, and
  // the rain shadow decides which of them go over the edge into true desert.
  const climate = fbm(x * 0.00021, z * 0.00019, seed + 907, 3, 2.1, 0.5) * 0.5 + 0.5
  // The shadow ramp is deliberately kilometres wide. A narrow one saturates
  // almost everywhere — `across` spans thousands of metres, so a 1.3 km ramp is
  // effectively a step — and the climate field then only decides which side of
  // a hard edge each point falls on. That produces a world that is half alpine
  // and half desert with nothing in between, and the semi-arid ground is the
  // most interesting part of the whole blend: it is where sandstone benches
  // still carry scrub in their hollows.
  const rainShadow = smoothstep(-1200, 3400, across)
  const aridity = clamp(
    // The massif makes its own weather. Even deep in the shadow the high
    // ground intercepts what moisture is left, so the desert belongs to the
    // basins and the low plateaux and thins out as the ground rises into the
    // range — which is also what keeps the snow line from meeting bare sand.
    smoothstep(0.46, 0.98, climate * 0.62 + rainShadow * 0.5) * (1 - massif * 0.55),
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

  // Open the authored showcase into a glacial rock basin. The regional field
  // naturally put a chain of billowed foothills through this exact view, which
  // made the foreground read as a dune field and hid both the river and most
  // mesh patches behind smooth swells. This is still a continuous base field,
  // but here it supplies subdued bedrock under the Boolean patchwork rather
  // than competing with it as the subject.
  const showcaseDistance = Math.hypot((x - 300) / 680, (z - 100) / 400)
  const showcaseBasin = 1 - smoothstep(0.55, 0.96, showcaseDistance)
  if (showcaseBasin > 0.001) {
    const floorUndulation =
      fbm(x * 0.012, z * 0.012, seed + 1_013, 2, 2.15, 0.48) * 1.8
    const bedrockRibs =
      (ridgedMultifractal(x * 0.024, z * 0.024, seed + 1_019, 3) - 0.48) * 2.25
    const basinFloor =
      WATER_LEVEL + 8 + (x - 300) * 0.006 + floorUndulation + bedrockRibs
    height = lerp(height, basinFloor, showcaseBasin * 0.88)
  }

  // The hero valley needs one legible drainage axis. The broad procedural
  // catchment sometimes leaves its low ground as an undirected lake, which is
  // visually flat and gives reflections no line through the composition. This
  // narrow, meandering glacial outlet is still part of the height field (not a
  // ribbon laid on top), so its banks, shadows, shoreline and water occlusion
  // are all real terrain and remain editable.
  const showcaseRiver = sampleShowcaseRiverProfile(x, z, seed)
  if (showcaseRiver.valley > 0.001) {
    const gravel = fbm(x * 0.027, z * 0.027, seed + 1_091, 2, 2.1, 0.5) * 1.35
    const riverBed = WATER_LEVEL - 4.6 + gravel
    height = lerp(
      height,
      Math.min(height, showcaseRiver.bankHeight + gravel * 0.45),
      showcaseRiver.valley * 0.86,
    )
    height = lerp(
      height,
      Math.min(height, riverBed),
      showcaseRiver.bed * 0.98,
    )
  }

  // Angular moraine and shallow bedrock ribs keep the showcase basin from
  // reading as a smoothed heightfield wherever no authored mesh operand lands.
  // Two octaves are enough at this metre scale; centimetre fracture remains a
  // material concern and the river bed is kept calm for legible reflections.
  const glacialRubble = ridgedMultifractal(
    x * 0.032,
    z * 0.032,
    seed + 1_127,
    2,
  )
  height +=
    (glacialRubble - 0.52) *
    1.55 *
    // On the distant walls this is real metre-scale surface relief, not a
    // normal-map substitute. Reusing the already-evaluated ridge field avoids
    // another cold-load noise stack while breaking the smooth procedural
    // massif into frost-shattered faces and a genuinely irregular silhouette.
    (0.7 + massif * 3.1) *
    (1 - showcaseRiver.bed * 0.88)

  // The mountain immediately behind the showcase thrust is a focal asset, not
  // a haze-only horizon proxy. Its former six-sample streamed source reduced a
  // 390 m massif to a handful of broad polygons; even at LOD0 the underlying
  // kilometre-scale ridge field supplied too little meso relief to catch a
  // normal, cast small self-shadows, or break the skyline. Confine two cheap
  // frost-fracture bands to that massif so the extra work and vertices are paid
  // only where the shipped camera can resolve them.
  const rearMassifDistance = Math.min(
    // Left rear peak.
    Math.hypot((x - 620) / 310, (z - 410) / 255),
    // The mountain immediately behind the hero in the shipped camera. A live
    // review ray lands at about (415, 393); the old mask never touched it and
    // therefore spent all of its focal detail on the neighbouring peak.
    Math.hypot((x - 420) / 245, (z - 395) / 215),
  )
  const rearMassifDetail =
    (1 - smoothstep(0.52, 1, rearMassifDistance)) *
    massif *
    (1 - showcaseRiver.bed * 0.92)
  if (rearMassifDetail > 0.001) {
    // Quantised low-frequency value fields form broad planar blocks and sharp
    // frost steps. The previous ridged multifractal was smooth at every scale:
    // more vertices only resolved the same melted billows more accurately.
    // These plateaus survive LOD1 because their shortest cell is still ~29 m,
    // while the bedding pass below cuts independent oblique ledges through
    // them instead of producing one repeated procedural comb.
    const jointField = valueNoise(
      x * 0.012,
      z * 0.012,
      seed + 1_163,
    )
    const chipField = valueNoise(
      (x + 37) * 0.034,
      (z - 61) * 0.034,
      seed + 1_177,
    )
    const jointBlocks = Math.floor(jointField * 6) / 5
    const faceChips = Math.floor(chipField * 5) / 4
    const faultPhase =
      x * 0.031 +
      z * 0.018 +
      valueNoise(x * 0.0045, z * 0.0045, seed + 1_181) * 1.35
    const faultFraction = faultPhase - Math.floor(faultPhase)
    const faultShelf =
      smoothstep(0.08, 0.2, faultFraction) *
      (1 - smoothstep(0.62, 0.84, faultFraction))
    height += (
      (jointBlocks - 0.5) * 16.5 +
      (faceChips - 0.5) * 4.8 +
      (faultShelf - 0.38) * 4.4
    ) * rearMassifDetail
  }

  // Near-field frost-shattered bedrock. The section source grid resolves this
  // four-to-nine-metre relief directly, so the foreground is not a perfectly
  // smooth height sheet between the authored CSG complexes. These two cheap
  // value-noise samples are intentionally subordinate to the mesh patches:
  // they break grazing highlights and collect shadow, but never manufacture a
  // landmark or an overhang that belongs in the Boolean topology.
  const rubbleMask = showcaseBasin * (1 - showcaseRiver.bed * 0.94)
  if (rubbleMask > 0.001) {
    // Interpolated noise only makes soft soil humps, even when its wavelength
    // is short. Glacially stripped bedrock instead breaks into shallow planar
    // plates separated by abrupt frost steps. Quantise two rotated value fields
    // before meshing: the 12–18 m band changes silhouette and casts real small
    // shadows, while the 5–8 m band facets those plates without spending source
    // triangles on centimetre detail that belongs in the scan normal map.
    const plateU = x * 0.829 + z * 0.559
    const plateV = z * 0.829 - x * 0.559
    const blockField = valueNoise(
      plateU * 0.071,
      plateV * 0.058,
      seed + 1_139,
    )
    const chipField = valueNoise(
      (plateU + plateV * 0.21) * 0.16,
      (plateV - plateU * 0.13) * 0.135,
      seed + 1_151,
    )
    const blockFaces = Math.floor(blockField * 6) / 5
    const chipFaces = Math.floor(chipField * 5) / 4
    height += (
      (blockFaces - 0.5) * 3.15 +
      (chipFaces - 0.5) * 0.72
    ) * rubbleMask
  }

  // --- 4b. the dune sea -------------------------------------------------
  // Dunes are geometry, not texture. A slipface is forty metres of ground at
  // the angle of repose with a brink line along the top, and it has to occlude
  // what is behind it, catch the sun on one side and hold shadow on the other.
  // No amount of normal perturbation on a flat plane produces that, which is
  // why this stage sits in the height field with the mountains rather than in
  // the material with the ripples.
  const erg = sampleErg(x, z, seed, aridity, massif, height)
  if (erg > 0.004) height += duneField(x, z, seed) * erg

  // --- 5. strata terracing ---------------------------------------------
  const steepness = estimateSteepness(x, z, seed, massif)
  const bedding = sampleBedding(x, z, seed)
  const terraced = applyStrata(height, x, z, seed, massif, steepness, bedding)

  return { height: terraced, massif, valley, flow, steepness, bedding, aridity, erg }
}

/**
 * Memoised whole-sample access.
 *
 * Meshing evaluates the height at every vertex and the material pass then needs
 * the terrain-derived fields at the same points. The stack behind these is nine
 * octaves of ridged multifractal plus a drainage network, so recomputing it
 * would roughly double compile time; a bounded map turns the second pass into
 * a lookup.
 *
 * The key is quantised rather than exact. The mesher asks at the full-precision
 * grid coordinate, but it then stores the vertex as a Float32 section-local
 * offset, so the material pass reconstructs `originX + position` and arrives at
 * a coordinate that differs in the last few bits — 4e-5 m at the far edge of a
 * section. Keyed exactly, 80 of every 89 grid columns therefore missed and paid
 * for the whole stack twice, which is what this cache exists to prevent.
 * Quantising to a quarter of a millimetre puts both spellings of the same
 * vertex in one bucket. Whichever caller arrives first decides the sample, and
 * that is the mesher at its exact coordinate, so the mesh itself is unchanged
 * and only the material pass moves — by a distance three orders of magnitude
 * below the finest feature any of these fields describes.
 */
// Four-way set associativity keeps lookup and eviction bounded while avoiding
// the per-entry hash nodes and iterator bookkeeping of a 300k-entry JS Map.
// Collisions can only cause a recomputation; they can never change a sample.
const SAMPLE_CACHE_WAYS = 4
const SAMPLE_CACHE_SET_COUNT = 1 << 16
const SAMPLE_CACHE_SET_MASK = SAMPLE_CACHE_SET_COUNT - 1
const SAMPLE_CACHE_CAPACITY = SAMPLE_CACHE_SET_COUNT * SAMPLE_CACHE_WAYS
const sampleCacheKeys = new Float64Array(SAMPLE_CACHE_CAPACITY)
const sampleCacheValid = new Uint8Array(SAMPLE_CACHE_CAPACITY)
const sampleCacheNextWay = new Uint8Array(SAMPLE_CACHE_SET_COUNT)
const sampleCacheValues: Array<HeightFieldSample | undefined> = new Array(
  SAMPLE_CACHE_CAPACITY,
)
/** Buckets per metre. A power of two keeps the quantisation itself exact. */
const SAMPLE_CACHE_QUANTUM = 4_096
/**
 * Half the addressable span either side of the origin. Keys are packed as
 * `qx * 2^25 + qz`, which stays inside the 53 bits a double represents exactly
 * as long as each axis fits in 25 bits. That covers +/- 4 km at the quantum
 * above; anything further out is a caller with no reuse to gain anyway.
 */
const SAMPLE_CACHE_ORIGIN = 1 << 24
const SAMPLE_CACHE_STRIDE = 1 << 25
/**
 * The seed used to be part of the key. Carrying it there made every entry pay
 * for it on every lookup even though a worker compiles one request at a time
 * and a whole request shares one seed; holding it beside the map and dropping
 * the map when it changes is the same invalidation for none of the per-sample
 * cost. `setWorldProfile` already clears on the other axis.
 */
let sampleCacheSeed: number | undefined

export function sampleHeightFieldCached(
  x: number,
  z: number,
  seed: number,
): HeightFieldSample {
  if (seed !== sampleCacheSeed) {
    clearSampleCache()
    sampleCacheSeed = seed
  }
  const qx = Math.round(x * SAMPLE_CACHE_QUANTUM) + SAMPLE_CACHE_ORIGIN
  const qz = Math.round(z * SAMPLE_CACHE_QUANTUM) + SAMPLE_CACHE_ORIGIN
  if (
    qx < 0 || qx >= SAMPLE_CACHE_STRIDE ||
    qz < 0 || qz >= SAMPLE_CACHE_STRIDE
  ) {
    return sampleHeightField(x, z, seed)
  }
  const key = qx * SAMPLE_CACHE_STRIDE + qz
  const set = sampleCacheSet(key)
  const firstSlot = set * SAMPLE_CACHE_WAYS
  for (let way = 0; way < SAMPLE_CACHE_WAYS; way += 1) {
    const slot = firstSlot + way
    if (sampleCacheValid[slot] !== 0 && sampleCacheKeys[slot] === key) {
      return sampleCacheValues[slot]!
    }
  }
  const sample = sampleHeightField(x, z, seed)
  const way = sampleCacheNextWay[set]
  const slot = firstSlot + way
  sampleCacheNextWay[set] = (way + 1) & (SAMPLE_CACHE_WAYS - 1)
  sampleCacheKeys[slot] = key
  sampleCacheValues[slot] = sample
  sampleCacheValid[slot] = 1
  return sample
}

function sampleCacheSet(key: number): number {
  const low = key >>> 0
  const high = Math.floor(key / 4_294_967_296) >>> 0
  let hash = Math.imul(low ^ high, 0x9e37_79b1)
  hash ^= hash >>> 16
  return hash & SAMPLE_CACHE_SET_MASK
}

function clearSampleCache(): void {
  sampleCacheValid.fill(0)
  sampleCacheNextWay.fill(0)
  sampleCacheValues.fill(undefined)
}

/** Convenience wrapper for callers that only need elevation. */
export function sampleHeight(x: number, z: number, seed: number): number {
  return sampleHeightFieldCached(x, z, seed).height
}

/** 0 outside the authored valley outlet, 1 on its gravel bed. */
export function sampleShowcaseRiver(
  x: number,
  z: number,
  seed: number,
): number {
  return sampleShowcaseRiverProfile(x, z, seed).bed
}

function sampleShowcaseRiverProfile(
  x: number,
  z: number,
  seed: number,
): { bed: number; valley: number; bankHeight: number } {
  const extent =
    smoothstep(-620, -510, z) * (1 - smoothstep(720, 850, z))
  if (extent <= 0) return { bed: 0, valley: 0, bankHeight: WATER_LEVEL }
  // The shipped camera looks north-east. In world space its screen-right axis
  // runs towards smaller X and larger Z, so the outlet must pass the hero on
  // this side to be visible. The previous centreline did the opposite: it sat
  // behind the landmark and only a thin reflective sliver escaped on the left.
  const centreX =
    (z < 180
      ? 200 + (z - 180) * 0.55
      : 200 - (z - 180) * 0.15) +
    Math.sin(z * 0.009) * 15 +
    Math.sin(z * 0.002 + seed * 0.0007) * 18
  const bankNoise =
    fbm(x * 0.012, z * 0.012, seed + 1_073, 2, 2.05, 0.5) * 10
  const relative = x - centreX + bankNoise
  const distance = Math.abs(relative)
  // A second meltwater thread splits around a gravel bar through the middle
  // distance, then rejoins before the narrow outlet. It is evaluated as part
  // of the same terrain profile, so the island between the threads is real
  // ground that occludes/reflects correctly rather than a dark shape painted
  // onto one wide water ribbon.
  const braid = smoothstep(105, 205, z) * (1 - smoothstep(470, 575, z))
  const branchOffset = 38 + Math.sin(z * 0.021 + 0.7) * 8
  const branchRelative = relative - branchOffset
  const branchDistance = Math.abs(branchRelative)
  const primaryBed = 1 - smoothstep(8, 22, distance)
  const branchBed = (1 - smoothstep(7, 18, branchDistance)) * braid
  // The mountain-side bank has room to open into a broad valley wall; the
  // landmark-side bank stays tight so the slab still appears rooted at the
  // channel's edge instead of floating in a flattened basin.
  const valleyWidth = relative < 0 ? 130 : 185
  const branchValleyWidth = branchRelative < 0 ? 92 : 120
  const primaryValley = 1 - smoothstep(28, valleyWidth, distance)
  const secondaryValley =
    (1 - smoothstep(24, branchValleyWidth, branchDistance)) * braid
  const nearestRelative = branchDistance < distance && braid > 0.2
    ? branchRelative
    : relative
  const nearestDistance = Math.min(distance, branchDistance + (1 - braid) * 1_000)
  return {
    bed: Math.max(primaryBed, branchBed) * extent,
    valley: Math.max(primaryValley, secondaryValley) * extent,
    bankHeight:
      WATER_LEVEL - 3.4 +
      Math.max(0, nearestDistance - 12) * (nearestRelative < 0 ? 0.42 : 0.28),
  }
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
    smoothstep(0.38, 1.4, steepness) *
    massif *
    (0.46 + bedding.expression * 0.54)
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
  return height + shift * clamp(0.72 * exposure * hardness, 0, 1)
}

/**
 * Wavelength and height of the primary dune chains, in metres.
 *
 * These are chosen together, not independently: the profile below puts the lee
 * face in the last `1 - DUNE_STOSS` of the wavelength, so 340 m and 46 m give a
 * slipface dropping 46 m over 92 m of ground — twenty-seven degrees at the
 * chain's mean height and steepening to the low thirties on the high draa,
 * which is the angle of repose for dry sand and therefore the only angle a
 * slipface is ever found at. Changing one of these without the other produces a
 * dune standing at an angle sand cannot actually hold.
 */
const DUNE_WAVELENGTH = 340
const DUNE_AMPLITUDE = 46
/** Fraction of the wavelength taken by the windward ramp. */
const DUNE_STOSS = 0.73

/**
 * Where wind-blown sand has taken the surface over completely.
 *
 * An erg needs three things at once, and the conjunction is what keeps the sand
 * sea somewhere specific rather than smeared over every dry cell of the map: a
 * climate with nothing growing to bind the surface, a regional supply of sand,
 * and a low, flat basin for it to collect in. Sand moves downwind, but it also
 * moves downhill and comes to rest at the bottom — so ergs floor the basins and
 * lap against the foot of the ranges rather than draping over them.
 */
export function sampleErg(
  x: number,
  z: number,
  seed: number,
  aridity: number,
  massif: number,
  baseHeight: number,
): number {
  if (aridity < 0.72) return 0
  const supply = fbm(x * 0.00013, z * 0.00013, seed + 971, 2, 2.1, 0.5) * 0.5 + 0.5
  // Sand pools in the low ground. The upper bound is deliberately generous —
  // a dune field really does climb a hundred metres onto a piedmont — but the
  // fall-off is what keeps it off the plateaux and out of the mountains.
  const basin = 1 - smoothstep(40, 190, baseHeight)
  return clamp(
    smoothstep(0.72, 0.95, aridity) *
      smoothstep(0.4, 0.72, supply) *
      basin *
      (1 - massif),
    0,
    1,
  )
}

/**
 * The asymmetric cross-section of one dune, over a 0..1 phase.
 *
 * This asymmetry is the entire reason a dune reads as a dune. A symmetric
 * bedform — which is what any noise function, ridged or billowed, gives you —
 * is a hill, and a field of them is a bumpy plain. What the eye recognises is a
 * long, gently concave windward ramp meeting a short planar slipface at a sharp
 * brink, with every dune in the field facing the same way because one wind
 * built all of them.
 */
export function duneProfile(phase: number): number {
  const t = phase - Math.floor(phase)
  const stoss = smoothstep(0, DUNE_STOSS, t)
  // The lee face is straight, not curved: sand avalanches down it until the
  // slope reaches the angle of repose and then stops, so the face is planar
  // from brink to base. Rounding it — which a falling smoothstep would do — is
  // most of what makes procedural dunes read as snowdrifts.
  const lee = 1 - (t - DUNE_STOSS) / (1 - DUNE_STOSS)
  // The brink is sharp but not infinitely so; wind rounds off the top few
  // metres. It also has to be rounded at all for the mesh to resolve it without
  // the crest line stepping between adjacent vertices.
  const brink = smoothstep(DUNE_STOSS - 0.008, DUNE_STOSS + 0.008, t)
  return lerp(stoss, lee, brink)
}

/**
 * Metres of dune relief standing above the basin floor.
 *
 * Crests run across the wind and link up into the long sinuous ridges of a
 * barchanoid field, with smaller dunes riding the windward slopes of the large
 * ones. Both come from displacing the *phase* rather than from adding
 * independent noise, which is what keeps each crest continuous along its whole
 * length instead of breaking into a row of separate mounds.
 */
export function duneField(x: number, z: number, seed: number): number {
  // One wind builds one dune field. The direction drifts over tens of
  // kilometres, as a regional wind regime does, but never locally — dunes a
  // kilometre apart facing different ways is the loudest possible tell.
  const windAngle =
    0.95 + fbm(x * 0.00008, z * 0.00008, seed + 973, 2, 2.1, 0.5) * 0.5
  const cos = Math.cos(windAngle)
  const sin = Math.sin(windAngle)
  const downwind = x * cos + z * sin
  const crosswind = z * cos - x * sin

  // Sinuosity: displacing the along-wind phase by an amount that varies across
  // the wind bends each crest into the linked crescents of a barchanoid ridge.
  //
  // Both constants are bounded by the angle of repose, which is the one thing a
  // sand surface may never exceed. The slipface already falls at roughly the
  // repose angle *down* the wind, so any crosswind gradient the phase
  // displacement adds is spent on top of that and tips the face past the angle
  // sand can hold. A lateral offset of a third of the dune spacing over a
  // ~600 m along-crest wavelength is what a barchanoid field actually shows,
  // and it costs about six degrees of crosswind tilt; the obvious first
  // guess — a full dune of offset over a couple of hundred metres — looks
  // right in plan and puts the slipfaces at eighty degrees.
  const sinuosity =
    fbm(crosswind * 0.0017, downwind * 0.0009, seed + 977, 3, 2.1, 0.5) * 0.35
  const phase = downwind / DUNE_WAVELENGTH + sinuosity
  const primary = duneProfile(phase)

  // Dune height is not uniform across a sand sea: chains of high draa alternate
  // with wide interdune corridors scoured back to the basin floor.
  const chain =
    0.35 +
    (fbm(crosswind * 0.00085, downwind * 0.00042, seed + 979, 2, 2.1, 0.5) * 0.5 +
      0.5) *
      0.85

  // Superimposed dunes, roughly a third the size, riding the windward ramp.
  // They are wiped off the slipface: a face avalanching at the angle of repose
  // destroys any bedform on it, so masking them below the brink is not a
  // cosmetic choice but the reason the slipfaces stay clean and readable.
  //
  // Their size and height are both bounded by what they cost the primary form.
  // Superimposed dunes carry their own lee faces, and those face the same way
  // as the draa's, so making them large enough to be interesting also makes
  // them steep enough to break the long windward ramp into a row of humps —
  // at which point the field reads as lumpy ground rather than as dune chains
  // and the one silhouette that says "desert" is gone. A third of the spacing
  // at a tenth of the height keeps their own lee near ten degrees, well under
  // the draa's, and holds the primary asymmetry at about 65:35 along the wind
  // against the 73:27 of the bare profile.
  const superPhase =
    downwind / (DUNE_WAVELENGTH * 0.3) +
    fbm(crosswind * 0.006, downwind * 0.0037, seed + 983, 2, 2.1, 0.5) * 0.8
  // The mask has to reach zero at *both* ends of the phase, and the toe end is
  // the one that is easy to get wrong. Ramping straight down from the toe to
  // the brink is the obvious form and it is discontinuous at the wrap: the mask
  // snaps from zero back to one exactly where one dune's slipface meets the
  // next dune's ramp, printing a step the full height of a superimposed dune
  // along the base of every slipface in the field. Growing them in over the
  // first fifth of the ramp — which is also what happens physically, since a
  // bedform needs fetch before it can build — closes it.
  const t = phase - Math.floor(phase)
  const stossMask =
    smoothstep(0, 0.22, t) * (1 - smoothstep(DUNE_STOSS - 0.18, DUNE_STOSS, t))
  const superimposed = duneProfile(superPhase) * stossMask * 0.1

  return (primary * chain + superimposed) * DUNE_AMPLITUDE
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
