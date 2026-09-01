import { clamp, lerp, smoothstep } from '../core/bounds'
import { WATER_LEVEL } from './climate'
import { THRUST_CENTER, THRUST_DEPTH } from '../demo/createThrustFormation'

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
  /**
   * The surface before `applyJointFaceting` cut it, in metres.
   *
   * Exposed because every field keyed to *altitude* has to read this one rather
   * than the finished height. Faceting shifts the surface locally, and using
   * that local cut to classify climate would make snow and vegetation follow
   * each slab rather than the mountain. The snow line is where that shows
   * worst, because it is the brightest thing in the palette and the band reads
   * as a tear in the terrain.
   *
   * Altitude is a *climatic* quantity: the snow line is where it is because of
   * lapse rate and aspect over kilometres, and it does not step by thirty
   * metres because a joint plane happens to pass through the hillside. So the
   * unfaceted height is not an approximation used to dodge an artefact, it is
   * the physically correct input, and the finished height stays where it
   * belongs — in the geometry.
   */
  baseHeight: number
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
  // Bedded rock is the exception in this range, not the rule.
  //
  // At 0.44 most of the massif came out bedded, and because terracing cuts a
  // bench per bed and vegetation colonises the treads, the result was a set of
  // perfectly regular parallel green stripes marching across every hillside for
  // hundreds of metres. Nothing reads as procedural faster. The reference this
  // world is aimed at is a granite mass: no bedding at all, its structure
  // entirely in the joint sets. Raising the threshold leaves a minority of the
  // range genuinely sedimentary — which is worth having for contrast — and
  // hands the rest to `applyJointFaceting`, where the faces come from
  // fractures rather than from layers.
  const expression = clamp(
    smoothstep(
      0.68,
      0.95,
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

/**
 * Exponent applied to the ridge field before it becomes elevation.
 *
 * The single strongest control over whether the range reads as rock or as
 * fantasy. A ridged multifractal is already peaked, and raising it to a power
 * peaks it further: at 1.55 every summit came to a point and the skyline was a
 * row of near-identical cones, which is the look the reference photograph most
 * obviously is not. Real granite stands in *masses* — broad shoulders and flat
 * summit domes, with the drama in the faces below them rather than in the
 * profile. Below one the field would flatten into plateaux; just above it
 * keeps the ridgelines continuous while letting the tops broaden, and the
 * relief that was in the spikes is handed to `applyJointFaceting`, which puts
 * it into faces that meet at edges instead of into points.
 */
const RIDGE_SHARPNESS = 1.15
// Reduced alongside `RIDGE_SHARPNESS`. A gentler exponent raises every value of
// a 0..1 field, so holding the old amplitude would have added a hundred-odd
// metres to the whole massif rather than only reshaping it.
const MOUNTAIN_AMPLITUDE = 430
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

/**
 * Distance between the samples the caller is about to take, in metres.
 *
 * This is the one thing that makes a coarse LOD a *smoothed* version of the
 * fine one rather than an independent surface. Without it every level point
 * samples the same unfiltered field: at the shipped resolutions LOD3 sits
 * 11.6 m apart and LOD4 21.3 m, while this stack carries structure down to
 * about 5 m, so the coarse levels were aliasing it — measured at 2.5 m RMS and
 * 7.7 m worst case away from the surface they were meant to approximate. That
 * is why a distant massif re-formed into a different mountain as the camera
 * approached, why neighbouring sections at different levels disagreed by metres
 * along their shared edge, and why the vegetation classifier flipped whole
 * sections to grass when a level changed under it.
 *
 * Every stage below is gated on it: octaves finer than the Nyquist limit fade
 * to their mean, and the stages that produce steps rather than noise — strata,
 * joint faceting, the quantised plate fields — fade out entirely once the grid
 * can no longer resolve them. Meshing a coarse level is therefore also
 * *cheaper* than meshing a fine one by more than the vertex count alone, which
 * is the opposite of what an unfiltered field does.
 *
 * Zero disables it, which is right for callers that want the true surface at a
 * point: planting queries, water, raycasts and the editor's cursor.
 */
let sampleFilterWidth = 0

export function setSampleFilterWidth(metres: number): void {
  const width = Number.isFinite(metres) && metres > 0 ? metres : 0
  if (width === sampleFilterWidth) return
  sampleFilterWidth = width
  clearSampleCache()
}

export function getSampleFilterWidth(): number {
  return sampleFilterWidth
}

/**
 * Samples per wavelength an octave needs before it is carried at full weight.
 *
 * Nyquist says two, and two is wrong here. Nyquist describes what an *ideal*
 * reconstruction filter can recover; a triangle mesh reconstructs by linear
 * interpolation between its vertices, which is a poor low-pass and passes
 * whatever it fails to resolve straight through as shape error. Measured on
 * the shipped massif at 21.3 m spacing, cutting at Nyquist left 2.14 m of
 * grid-dependent divergence above the 0.84 m interpolation floor; cutting at
 * six halves that again, and the detail given up is detail the material's own
 * band-limited surface synthesis is already drawing per-pixel.
 */
const SAMPLES_PER_WAVELENGTH = 4

/**
 * Evaluates `fn` with band limiting switched off, without disturbing the cache.
 *
 * For the section boundary ring, which two independently compiled neighbours
 * both own. Each would otherwise filter it to *its own* grid, so a section next
 * to a coarser one would place the shared edge somewhere its neighbour did not
 * — a crack, metres tall on a cliff, and the reason the skirts hanging over
 * those cracks had grown deep enough to show through the hillside in front of
 * them. Evaluated canonically the edge is the same curve on both sides
 * whatever levels meet there, which is a seam that does not need hiding.
 *
 * The width is restored rather than re-set through `setSampleFilterWidth`
 * because that clears the sample cache, and this runs per boundary vertex.
 * Cached reads are bypassed while it is in effect for the same reason: a
 * canonical sample must not be stored under a key the filtered interior will
 * later read back.
 */
export function withCanonicalSampling<T>(fn: () => T): T {
  if (sampleFilterWidth === 0) return fn()
  const previous = sampleFilterWidth
  sampleFilterWidth = 0
  canonicalSampling = true
  try {
    return fn()
  } finally {
    sampleFilterWidth = previous
    canonicalSampling = false
  }
}

let canonicalSampling = false

/**
 * How much of one octave survives the current sample spacing.
 *
 * Full weight at `SAMPLES_PER_WAVELENGTH`, nothing at half that, and a linear
 * ramp between, so an octave leaves gradually as a section coarsens instead of
 * vanishing between one level and the next.
 */
function octaveGain(wavelength: number): number {
  if (sampleFilterWidth <= 0) return 1
  return clamp(
    (2 * wavelength) / (SAMPLES_PER_WAVELENGTH * sampleFilterWidth) - 1,
    0,
    1,
  )
}

/**
 * The same ramp for a whole stage rather than one octave.
 *
 * Terracing, joint faceting and the quantised plate fields do not decompose
 * into octaves: they put *steps* in the surface, and a step has energy at every
 * frequency however smooth its input was. There is no partial version of one to
 * keep, so a stage whose features are smaller than the grid can resolve is
 * faded out as a whole and the smooth surface underneath is what remains.
 */
function detailGain(featureSize: number): number {
  return octaveGain(featureSize)
}

/** Elevation the flat profile sits at: above the water level, so a new world is dry. */
export const FLAT_GROUND_LEVEL = WATER_LEVEL + 12

function sampleFlatField(x: number, z: number, seed: number): HeightFieldSample {
  // A couple of metres of very broad undulation plus centimetre grain. Without
  // it the plain shades as one flat colour and neither the sun angle nor an
  // early brush stroke is legible against it.
  const swell = fbm(x * 0.0009, z * 0.0009, seed + 61, 2, 2.1, 0.5) * 2.4
  const grain =
    fbm(x * 0.021, z * 0.021, seed + 67, 2, 2.1, 0.5, 1 / 0.021) * 0.35
  const flatHeight = FLAT_GROUND_LEVEL + swell + grain
  return {
    height: flatHeight,
    // The flat profile is never faceted, so the two heights coincide.
    baseHeight: flatHeight,
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
    1 / 0.00085,
  )
  // Sharpening the ridge profile raises the peaks and flattens the basins,
  // which reads as glacial relief rather than as noise.
  const mountains = Math.pow(ridge, RIDGE_SHARPNESS) * MOUNTAIN_AMPLITUDE * massif

  // --- 3. foothills and plains -----------------------------------------
  const foothills =
    billow(x * 0.0034, z * 0.0034, seed + 211, 4, 1 / 0.0034) *
    FOOTHILL_AMPLITUDE *
    (0.35 + massif * 0.9)
  const plains =
    fbm(x * 0.0062, z * 0.0062, seed + 307, 4, 2.15, 0.52, 1 / 0.0062) *
    PLAIN_AMPLITUDE

  let height = SEA_LEVEL + mountains + foothills + plains + along * 0.004

  // --- 4. valleys -------------------------------------------------------
  // A second ridge field, inverted, used as a drainage network. Its channels
  // cut deepest where the terrain is highest, mimicking headward erosion.
  const drainage = ridgedMultifractal(
    (x - warpZ * 0.4) * 0.00062,
    (z + warpX * 0.4) * 0.00062,
    seed + 401,
    5,
    1 / 0.00062,
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
      fbm(x * 0.012, z * 0.012, seed + 1_013, 2, 2.15, 0.48, 1 / 0.012) * 1.8
    const bedrockRibs =
      (ridgedMultifractal(x * 0.024, z * 0.024, seed + 1_019, 3, 1 / 0.024) -
        0.48) *
      2.25
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
    const gravel =
      fbm(x * 0.027, z * 0.027, seed + 1_091, 2, 2.1, 0.5, 1 / 0.027) * 1.35
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
    1 / 0.032,
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
    // Each term is a zero-mean displacement about the smooth surface, so a grid
    // that cannot resolve one drops it and lands on the surface it was
    // perturbing.
    //
    // What has to be resolved is the *plateau*, not the noise wavelength that
    // generated it. Quantising divides one 83 m noise cell into six levels, so
    // the flats are about fourteen metres across and the risers between them
    // are infinitely sharp — a 21 m grid lands on one side or the other of a
    // riser at random and moves the surface by most of the sixteen-metre step.
    // Gating on the wavelength instead left this term 95% active at the
    // coarsest level and it was the single largest source of LOD disagreement
    // in the massif.
    height += (
      (jointBlocks - 0.5) * 16.5 * detailGain(1 / 0.012 / 6) +
      (faceChips - 0.5) * 4.8 * detailGain(1 / 0.034 / 5) +
      (faultShelf - 0.38) * 4.4 * detailGain(1 / 0.031 * 0.15)
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
    // Plateau width again, not wavelength: six and five levels respectively.
    height += (
      (blockFaces - 0.5) * 3.15 * detailGain(1 / 0.071 / 6) +
      (chipFaces - 0.5) * 0.72 * detailGain(1 / 0.16 / 5)
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
  // Faceting runs after terracing, not before it. The beds decide where the
  // rock is weak and the joints then break it along those weaknesses; doing it
  // the other way round terraces a surface that has already been cut into
  // planes and puts a staircase across every facet.
  const faceted = applyJointFaceting(
    terraced,
    x,
    z,
    seed,
    massif,
    steepness,
    valley,
    bedding,
  )

  return {
    height: faceted.height,
    baseHeight: terraced,
    massif,
    valley,
    flow,
    steepness,
    bedding,
    aridity,
    erg,
  }
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
  // See `withCanonicalSampling`: the cache is keyed on position alone, so a
  // sample taken at a different filter width must neither be read from it nor
  // written to it.
  if (canonicalSampling) return sampleHeightField(x, z, seed)
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
    fbm(x * 0.012, z * 0.012, seed + 1_073, 2, 2.05, 0.5, 1 / 0.012) * 10
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
  // A fixed baseline, deliberately not the sample spacing.
  //
  // Scaling it with the grid was measured to make no useful difference to the
  // geometry's LOD agreement, and it costs something that matters more: this
  // value reaches the material classifier as `baseNormalY`, which is the one
  // slope input the vegetation gate can rely on *not* to move between levels.
  const delta = 9
  // The domain warp is evaluated once and shared by all three probes. It varies
  // over hundreds of metres and they are nine metres apart, so computing it per
  // probe measured the same displacement three times over — four of the ten
  // noise octaves this estimate costs, and it is called for every vertex of
  // every section.
  const warpX = fbm(x * 0.0011, z * 0.0011, seed + 71, 2, 2.2, 0.5) * 240
  const warpZ =
    fbm(x * 0.0011 + 5.7, z * 0.0011 - 3.1, seed + 73, 2, 2.2, 0.5) * 240
  const centre = warpedRelief(x, z, warpX, warpZ, seed)
  const dx = warpedRelief(x + delta, z, warpX, warpZ, seed) - centre
  const dz = warpedRelief(x, z + delta, warpX, warpZ, seed) - centre
  // Scaled by the same mask the relief itself is scaled by.
  //
  // `coarseRelief` is the bare ridge stack at full amplitude, but the height
  // field only ever adds `mountains = relief * massif`. Reporting the unmasked
  // gradient therefore over-states the slope by 1/massif — tenfold out on the
  // fringes, where the ground is nearly flat and this claimed a 45-degree face.
  // Everything keyed to steepness inherited that: terracing and joint faceting
  // fired on gentle ground, and once the material classifier started reading
  // this slope it stripped the vegetation off entire temperate hillsides.
  return (Math.hypot(dx, dz) / delta) * massif
}

/** The mountain term at a point whose domain warp the caller already has. */
function warpedRelief(
  x: number,
  z: number,
  warpX: number,
  warpZ: number,
  seed: number,
): number {
  const ridge = ridgedMultifractal(
    (x + warpX) * 0.00085,
    (z + warpZ) * 0.00085,
    seed + 101,
    6,
    1 / 0.00085,
  )
  return Math.pow(ridge, RIDGE_SHARPNESS) * MOUNTAIN_AMPLITUDE
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
  // A ledge-and-riser profile at a bed's own spacing is invisible on a grid
  // that cannot resolve one, and point-sampling it there does not average it —
  // it lands on an arbitrary phase of the staircase and moves the surface by
  // most of a bed. Terracing pulls towards the *nearest* plane, above or below,
  // so its mean displacement is zero and fading it out is a true low-pass.
  const exposure =
    smoothstep(0.38, 1.4, steepness) *
    massif *
    (0.46 + bedding.expression * 0.54) *
    detailGain(bedding.thickness)
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
  // Wide enough that the riser stays rasterisable.
  //
  // A narrow transition makes the riser near-vertical, and near-vertical is
  // where a height field stops working: the face becomes a ribbon of triangles
  // spanning tens of metres of drop across one sample of ground, and seen
  // anywhere near edge-on it projects to less than a pixel. The rasteriser then
  // produces no fragment for it and the background shows through — the pale
  // slivers that have been read as holes in the cliff for weeks. Measured
  // before this bound, the steepest faces in the massif stood at 88 degrees.
  //
  // The band is expressed as the share of a bed the riser occupies, and a bed
  // is `thickness` thick, so this is a real world-space run: at the 9-26 m
  // thicknesses `sampleBedding` produces it keeps the face near seventy
  // degrees, which still reads as a wall from any distance and survives being
  // drawn.
  const riserBand = Math.max(
    STRATA_MIN_RISER_BAND,
    STRATA_MIN_RISER_METRES / Math.max(1, bedding.thickness),
  )
  const snapped =
    index +
    smoothstep(0.5 - riserBand * 0.5, 0.5 + riserBand * 0.5, fraction)
  // Convert the correction back to a vertical displacement. Dividing by the
  // normal's vertical component moves the point onto the plane along Y, which
  // is the only axis a heightfield may move on.
  const shift = ((snapped - band) * bedding.thickness) / bedding.normalY
  return height + shift * clamp(0.72 * exposure * hardness, 0, 1)
}

/**
 * Least share of a bed its riser may occupy, and the least run in metres.
 *
 * Both bounds exist because bed thickness varies four-fold: the fraction keeps
 * thin beds from stacking into a comb, the metre floor keeps thick ones from
 * standing a thirty-metre step on a two-metre run.
 */
const STRATA_MIN_RISER_BAND = 0.34
const STRATA_MIN_RISER_METRES = 7

/**
 * Joint-plane faceting: what makes a rock face a rock face.
 *
 * Everything upstream of this is a smooth, C1-continuous sum of noise —
 * `ridgedMultifractal`, `billow`, `fbm` — and a smooth function has no edges
 * in it anywhere. Every silhouette it produces is a contour of one differentiable
 * surface, which is precisely why a procedural mountain reads as a height field
 * however much relief it is given and however good the material on top of it is.
 * The two existing attempts at breaking that up quantise the height into steps,
 * and quantising a height gives *horizontal terraces* — flat-topped plateaux at
 * discrete elevations. A real face has almost no horizontal surfaces on it.
 *
 * What it has instead is planar facets at every angle: slabs tens of metres
 * across, meeting each other along sharp arêtes, all of them parallel to one of
 * a handful of regional joint attitudes. That structure is not decoration on
 * the landform, it *is* the landform — a rock mass is a solid bounded by the
 * fractures running through it, and erosion exposes those fractures as faces
 * because they are where the rock was already weakest.
 *
 * So this cuts, rather than adds. Each joint set is a family of parallel planes
 * spaced through the rock; the exposed surface is the lower envelope of the
 * smooth height and every plane that passes below it. Cutting is what makes the
 * result planar: where a plane wins, the surface *is* that plane over its whole
 * extent, so the facet is genuinely flat and its boundary with the next facet is
 * genuinely an edge. Adding a signal, however sharp, can only ever modulate the
 * smooth surface and leaves it smooth.
 *
 * Three properties follow from the construction rather than from tuning:
 *
 *   Faces are planar.       A plane clipped against a surface is a plane.
 *   Edges are straight.     Two planes meet in a line.
 *   Faces are parallel.     Every facet of one set shares one attitude, which
 *                           is what makes a real cliff read as *structured*
 *                           rather than as randomly crumpled.
 *
 * The sets are keyed to the same `Bedding` attitude the material shades its
 * strata from, so the geometric facet and the shaded band belong to one rock.
 */

/**
 * How far a joint plane may cut below the smooth surface, in metres.
 *
 * A cap, not a target. Without one a plane that happens to pass far below the
 * ground removes an entire ridge, and the landform the regional fields worked
 * to produce disappears into a heap of triangles. Twenty-eight metres is deep
 * enough for a facet to read as a face at three hundred metres and shallow
 * enough that the massif keeps its shape.
 */
export const JOINT_MAX_CUT = 26
/**
 * Rounding on the arête where two facets meet, in metres.
 *
 * Real fracture edges are not razors — they are chipped and weathered back by
 * metres. It matters more for the mesh than for realism: a true crease falls
 * between source samples at 1.45 m spacing and aliases, and at the first
 * working version of this stage — 1.6 m of rounding against steps of twenty
 * metres — the aliasing was the dominant feature of the whole massif, which
 * came out as a forest of pinnacles rather than a face of slabs. The rounding
 * has to be a real fraction of the step it is smoothing, not of the sample
 * spacing.
 */
const JOINT_EDGE_ROUNDING = 5.5


/**
 * Mean depth one joint family removes, as a fraction of its step height.
 *
 * Closed form. `jointPlaneHeight` blends from the plane below a point to the
 * one above across the interval, so with `f` the phase the plane sits
 * `(S(f) - f) * spacing / normalY` from the surface for `S` the smoothstep.
 * That is a cut only on the lower half, and the mean is
 * `∫₀^½ f df − ∫₀^½ (3f² − 2f³) df = 0.125 − 0.09375 = 0.03125`.
 *
 * It matters because a joint cut is one-sided: this is what the cut is
 * band-limited *towards*, and getting it wrong makes the massif change height
 * with distance.
 */
const JOINT_MEAN_CUT_FRACTION = 0.03125

/** Smooth minimum. Rounds the intersection of two surfaces over `k` metres. */
function smoothMin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b)
  const spread = Math.abs(a - b)
  if (spread >= k) return Math.min(a, b)
  const h = k - spread
  return Math.min(a, b) - (h * h) / (k * 4)
}

/**
 * Clips the surface against one family of parallel planes.
 *
 * `along` is the signed distance from the origin measured along the plane
 * normal, in metres; the planes sit at multiples of `spacing` along it, offset
 * by `phase`. Only the nearest plane below the point can cut it, so this is one
 * floor and one divide rather than a search.
 *
 * The phase is a per-family constant rather than a per-plane jitter, and that
 * is a correctness requirement rather than a simplification: jittering each
 * plane independently lets one plane cross another, and once the family is no
 * longer monotonic in its index the floor above selects a plane that is not the
 * nearest one below — which puts a facet on the wrong side of its own edge.
 *
 * The normal's vertical component is what limits this. A heightfield stores one
 * height per column, so it can express a plane of any dip short of vertical and
 * cannot express an overhang at all; as `normalY` approaches zero the plane's
 * height at a column runs to infinity and the cut does nothing. Rather than let
 * that degrade silently, the caller only ever passes attitudes this can carry.
 */
function clipToJointSet(
  height: number,
  x: number,
  z: number,
  normalX: number,
  normalY: number,
  normalZ: number,
  spacing: number,
  phase: number,
  strength: number,
): number {
  const along = normalX * x + normalY * height + normalZ * z
  // The plane at or just *below* the point, along the normal. It is the only
  // one that can remove anything: a plane above the surface clips nothing, and
  // selecting it — which the first version of this did — makes the whole stage
  // an expensive no-op that leaves the terrain exactly as smooth as it found
  // it. `floor` selects the slab, but its hard switch must not survive into a
  // height field: unlike a closed mesh it has no vertical face to fill that
  // discontinuity. `jointPlaneHeight` blends through the following plane over
  // the inter-plane interval, retaining the joint direction without producing
  // an unfillable wall.
  const planeHeight = jointPlaneHeight(
    along,
    x,
    z,
    normalX,
    normalY,
    normalZ,
    spacing,
    phase,
  )
  // A plane that would take more than the cap is pulled back to it, so a facet
  // deepens smoothly to its limit instead of the cut switching off. The water
  // line is a second, absolute floor: the exposure gate already keeps this
  // stage away from the shore, and this makes it impossible for a facet to
  // breach the surface of a river or a lake even if that gate is ever loosened.
  const floorHeight = Math.max(height - JOINT_MAX_CUT, WATER_LEVEL + 6)
  const clipped = smoothMin(
    height,
    Math.max(planeHeight, floorHeight),
    JOINT_EDGE_ROUNDING,
  )
  // Band-limited towards the mean cut, not towards no cut.
  //
  // A joint cut is one-sided: it only ever removes rock. Fading it out the way
  // the zero-mean stages fade would let the massif *grow* by tens of metres as
  // it recedes — the same "different mountain", from the other direction. So
  // once the grid can no longer resolve a facet, what remains is the average
  // depth the family removes, which `JOINT_MEAN_CUT_FRACTION` gives in closed
  // form, and only the sharpness of the arête is lost.
  //
  // Widening `smoothMin` instead of this looks like the natural move and is
  // wrong: it subtracts up to `k / 4` on its own, so a rounding scaled to a
  // 21 m grid pulled the whole surface thirteen metres down.
  // Gated on the *facet*, not on the step between facets.
  //
  // A tall step is not what a coarse grid cannot carry — a wide flat plane with
  // one sharp edge is perfectly representable at any spacing. What it cannot
  // carry is the arête, which is `JOINT_EDGE_ROUNDING` wide however large the
  // slabs are, and a grid that lands two samples either side of one puts the
  // crease wherever the samples happen to fall. Fading on a fraction of the
  // facet width retires the whole family once its edges stop resolving, and the
  // mean-cut blend below keeps the massif at the height it had.
  // Always on. The riser widens with the sample spacing, so the family stays
  // resolvable at every level and needs no fade of its own; fading it as well
  // stripped distant mountains back to smooth shapes, which is exactly the
  // "far away it is a completely different, flatter mountain" this pass is
  // meant to remove. What changes with distance is the softness of the arête,
  // not whether the faces are there.
  // Always on. The facet's edge is spread over the whole inter-plane interval,
  // so it stays resolvable at every level and the family needs no fade of its
  // own. Fading it as well is what stripped distant mountains back to smooth
  // shapes — the "far away it is a completely different, flatter mountain"
  // this pass exists to remove. What changes with distance is the softness of
  // the arête, not whether the faces are there at all.
  const band = detailGain(spacing * 2)
  const cut = band >= 1
    ? clipped - height
    : lerp(
      -JOINT_MEAN_CUT_FRACTION * spacing / normalY,
      clipped - height,
      band,
    )
  return height + Math.max(cut, floorHeight - height) * strength
}

function jointPlaneHeight(
  along: number,
  x: number,
  z: number,
  normalX: number,
  normalY: number,
  normalZ: number,
  spacing: number,
  phase: number,
): number {
  const coordinate = (along - phase) / spacing
  const planeIndex = Math.floor(coordinate)
  const planeOffset = planeIndex * spacing + phase
  const current = (planeOffset - normalX * x - normalZ * z) / normalY

  const fraction = coordinate - planeIndex
  // Blended across the whole inter-plane interval, deliberately.
  //
  // Holding the plane flat and stepping over a narrow riser is what makes a
  // facet read as a face, and it was tried: the massif gained real buttresses
  // and walls. It also put ten per cent of the surface past eighty degrees,
  // and that is where a height field stops being able to draw itself. Such a
  // face is a ribbon of triangles carrying tens of metres of drop across one
  // sample of ground; seen near edge-on it projects to under a pixel, the
  // rasteriser emits no fragment, and the background shows through as a pale
  // sliver. Those slivers are the "holes in the cliff".
  //
  // It is not a tuning problem. The riser's gradient goes as
  // `1.5 * (spacing / riser) * (nx / ny)`, so holding a facet under seventy
  // degrees at this joint spacing needs a riser of twenty-three to
  // fifty-five metres — which is the whole interval, i.e. this. Sharp facets
  // and bounded slope cannot both exist in a height field; the faces have to
  // come from the 3D path instead.
  const next = current + spacing / normalY
  return lerp(
    current,
    next,
    smoothstep(0, 1, fraction),
  )
}

/**
 * Facets exposed bedrock against the regional joint sets.
 *
 * Two sets: the bedding, which supplies the slabs, and one conjugate shear set
 * that truncates them. See the note on the shear set for why a heightfield
 * cannot usefully take the third.
 */
function applyJointFaceting(
  height: number,
  x: number,
  z: number,
  seed: number,
  massif: number,
  steepness: number,
  valley: number,
  bedding: Bedding,
): { height: number; wall: number } {
  // Bedrock is exposed where the ground is too steep to hold cover. Below that
  // it is under soil and scree and has no business being faceted — a faceted
  // meadow is worse than a smooth one.
  //
  // The other two gates are about what this stage is allowed to *remove*, and
  // they were both missing from the first version. Faceting only ever cuts
  // downward, by up to `JOINT_MAX_CUT`, and a stage that quietly takes thirty
  // metres out of any steep ground anywhere takes it out of the valley walls
  // and the river banks too — which put the deep water through the floor of
  // its own channel and left the authored portal chambers opening onto a
  // surface thirty metres below where they were cut. Neither showed up in a
  // frame; both showed up as a failing assertion about the ground the rest of
  // the composition is built on.
  //
  // A valley floor is a depositional surface. Whatever the joints in the rock
  // beneath it are doing, what is at the surface is alluvium, and it is flat.
  const drained = 1 - smoothstep(0.18, 0.62, valley)
  // Authored topology owns its own ground.
  //
  // The hero thrust formation is exact CSG: its chambers are cut *into* a
  // surface, and their apertures only open where that surface is where the
  // author put it. Faceting takes up to thirty metres out of any steep ground
  // it is given, so run over the landmark it moves the wall the chambers were
  // cut through and leaves them opening onto nothing — the geometry is still
  // there, and it no longer meets the outside. Procedural structure yields to
  // the composition here rather than the other way round, and the radius is
  // the formation's own depth with a wide margin: the chambers are cut
  // through its outer face, so the ground that has to stay put reaches well
  // beyond the centre the depth is measured from.
  const authoredX = (x - THRUST_CENTER.x) / (THRUST_DEPTH * 2.4)
  const authoredZ = (z - THRUST_CENTER.z) / (THRUST_DEPTH * 2.4)
  const authored = smoothstep(
    0.7,
    1.15,
    Math.hypot(authoredX, authoredZ),
  )
  // Nothing is faceted within a good margin of the water line. Rock does
  // outcrop at a shoreline, but a cut here has nowhere to go: the channel was
  // carved to a depth the river needs, and taking another thirty metres out of
  // its bank drops the bed itself below the water it is supposed to contain.
  const aboveWater = smoothstep(WATER_LEVEL + 10, WATER_LEVEL + 52, height)
  // Faceting has to *make* the steep ground, not wait for it.
  //
  // With the ridge exponent broadened so the massif stands in masses rather
  // than spikes, the noise no longer hands over the near-vertical slopes this
  // gate used to open on, and keying it at 0.42 left the whole range smooth —
  // broad, yes, and completely characterless. In real granite the faces are
  // where they are *because* the joints are there: erosion strips the rock back
  // to the fractures, and a moderate slope is exactly the ground on which that
  // produces a wall. So the gate opens on moderate ground and the cut is deep
  // enough to build a face from it.
  const exposure =
    smoothstep(0.2, 0.72, steepness) *
    smoothstep(0.25, 0.7, massif) *
    drained *
    aboveWater *
    authored
  if (exposure < 0.02) return { height, wall: 0 }

  // Block size varies over the massif: some of a face is closely jointed and
  // breaks into small plates, some is massive and gives one huge slab. This is
  // the single strongest cue that a cliff is rock rather than a shape.
  const spacingField =
    fbm(x * 0.00085, z * 0.00085, seed + 1_303, 2, 2.1, 0.5) * 0.5 + 0.5
  // Slab scale, and it has to be. A family's facets are separated by a step of
  // `spacing / normalY`, so the spacing is not just how big a facet is — it is
  // also how tall the wall at its edge is. At nine to twenty-four metres, with
  // three families intersecting, the walls were as tall as the facets were
  // wide and the massif came out as a forest of columns. Wide spacing gives
  // what the reference actually shows: slabs tens of metres across with one
  // clean edge each.
  const spacing = 34 + spacingField * 46
  // Where the family sits between its planes. Drifts over kilometres, so one
  // massif is broken on one set of surfaces rather than the phase resetting
  // from column to column.
  const phase =
    (fbm(x * 0.0007, z * 0.0007, seed + 1_297, 2, 2.1, 0.5) * 0.5 + 0.5) * spacing

  // Set one is the bedding itself, which is already the attitude the material
  // shades its bands from.
  let result = height
  if (bedding.normalY > 0.22) {
    result = clipToJointSet(
      result,
      x,
      z,
      bedding.normalX,
      bedding.normalY,
      bedding.normalZ,
      spacing,
      phase,
      exposure,
    )
  }

  // Two conjugate sets, steeply inclined and rotated either side of the
  // bedding strike. Their dip is kept clear of vertical: a heightfield cannot
  // represent a plane steeper than its own columns, and a near-vertical joint
  // asked to cut one produces a numerical cliff rather than a facet.
  //
  // One conjugate shear set, not two. Two is what a rock mass has and two is
  // what this had first; the trouble is that a heightfield can only ever show
  // the *lower* envelope of them, so a second steep family does not add a
  // second visible direction of face — it subtracts from the first, and what
  // survives is the narrow intersection of both. Cutting to one leaves whole
  // slabs standing, which is the thing the second family was destroying.
  const strike = Math.atan2(bedding.normalX, bedding.normalZ)
  const shearDip =
    0.62 + (fbm(x * 0.0006, z * 0.0006, seed + 1_311, 2, 2.1, 0.5) * 0.5 + 0.5) * 0.34
  const sinDip = Math.sin(shearDip)
  const azimuth = strike + 1.02
  result = clipToJointSet(
    result,
    x,
    z,
    Math.sin(azimuth) * sinDip,
    Math.cos(shearDip),
    Math.cos(azimuth) * sinDip,
    spacing * 1.34,
    phase * 1.7,
    // Subordinate on purpose. The bedding set carries the face; this one
    // truncates its slabs at an angle so they end in a real edge rather than
    // running off the side of the landform. Kept well below half now that the
    // risers are sharp: two families cutting hard in different directions
    // leaves only their intersection standing, which is a spike, not a slab.
    exposure * 0.28,
  )

  return { height: result, wall: exposure }
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

/**
 * Mean of one ridged octave's signal, `(1 - |2u - 1|)^2` for uniform `u`.
 *
 * Needed because a ridged octave is not zero-mean. Dropping one below the
 * sample spacing would therefore lower the surface, and a massif that loses
 * height as it recedes is exactly the "different mountain" the LOD is supposed
 * to be avoiding. Substituting the mean removes the detail and keeps the level.
 */
const RIDGE_OCTAVE_MEAN = 1 / 3
/** Mean of one billow octave's signal, `|2u - 1|`. */
const BILLOW_OCTAVE_MEAN = 0.5

/**
 * `baseWavelength` is the world-space wavelength of octave zero, in metres, and
 * is what lets the octave loop stop at the sample spacing. Passing zero — the
 * default — disables band limiting for callers whose finest octave is far
 * coarser than any grid this world meshes at.
 */
function ridgedMultifractal(
  x: number,
  z: number,
  seed: number,
  octaves: number,
  baseWavelength = 0,
): number {
  let sum = 0
  let amplitude = 0.52
  let frequency = 1
  let weight = 1
  let total = 0
  for (let octave = 0; octave < octaves; octave += 1) {
    const band = baseWavelength > 0
      ? octaveGain(baseWavelength / frequency)
      : 1
    // Below the sample spacing the octave carries its expected value instead of
    // its noise. The recursion still advances, so the octaves under it stay on
    // the same footing they would have had — and it costs no hashing, which is
    // where the compile-time saving at coarse LODs comes from.
    let signal: number
    if (band <= 0) {
      signal = weight * RIDGE_OCTAVE_MEAN
    } else {
      let raw = 1 - Math.abs(
        valueNoise(x * frequency, z * frequency, seed + octave * 37) * 2 - 1,
      )
      raw *= raw
      // Weighting each octave by the previous one concentrates detail on the
      // ridges and leaves the flanks smooth — the defining trait of the form.
      raw *= weight
      // Fade the last resolvable octave towards its mean rather than switching
      // it off, so a section does not change shape the instant it crosses an
      // LOD boundary.
      signal = band >= 1
        ? raw
        : lerp(weight * RIDGE_OCTAVE_MEAN, raw, band)
    }
    sum += signal * amplitude
    weight = clamp(signal * 2.2, 0, 1)
    total += amplitude
    amplitude *= 0.52
    frequency *= 2.07
  }
  return clamp(sum / total, 0, 1)
}

function billow(
  x: number,
  z: number,
  seed: number,
  octaves: number,
  baseWavelength = 0,
): number {
  let sum = 0
  let amplitude = 0.5
  let frequency = 1
  let total = 0
  for (let octave = 0; octave < octaves; octave += 1) {
    const band = baseWavelength > 0
      ? octaveGain(baseWavelength / frequency)
      : 1
    const signal = band > 0
      ? Math.abs(valueNoise(x * frequency, z * frequency, seed + octave * 53) * 2 - 1)
      : BILLOW_OCTAVE_MEAN
    sum += (band >= 1 ? signal : lerp(BILLOW_OCTAVE_MEAN, signal, band)) * amplitude
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
  baseWavelength = 0,
): number {
  let sum = 0
  let amplitude = 0.5
  let frequency = 1
  // The divisor is the *full* octave stack's amplitude, not just the octaves
  // that survive band limiting. An fbm octave is zero-mean, so leaving one out
  // is a genuine low-pass of the same field — but only if the octaves that
  // remain keep the absolute amplitude they always had. Dividing by a shrunken
  // total would instead amplify what is left, and the coarse LOD would come
  // back as a different, louder surface.
  const total = gain === 1
    ? 0.5 * octaves
    : 0.5 * (1 - Math.pow(gain, octaves)) / (1 - gain)
  for (let octave = 0; octave < octaves; octave += 1) {
    const band = baseWavelength > 0
      ? octaveGain(baseWavelength / frequency)
      : 1
    if (band <= 0) break
    sum +=
      (valueNoise(x * frequency, z * frequency, seed + octave * 17) * 2 - 1) *
      amplitude *
      band
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
