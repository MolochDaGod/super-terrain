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
