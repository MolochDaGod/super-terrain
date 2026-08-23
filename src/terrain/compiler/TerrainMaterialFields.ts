import {
  SNOW_LINE,
  SNOW_LINE_BAND,
  WATER_LEVEL,
  WATER_TABLE_REACH,
} from './climate'
import { clamp, smoothstep } from '../core/bounds'
import { sampleHeightFieldCached } from './heightField'

export interface TerrainMaterialFields {
  regional: number
  /** Up component of the undeformed height-field normal at this X/Z. */
  baseNormalY: number
  /** Barren showcase basin where exposed bedrock replaces pasture/regolith. */
  bedrockExposure: number
  /** Regolith depth proxy in 0..1: where loose material can come to rest. */
  deposition: number
  /** Ground water availability in 0..1, from drainage and altitude. */
  moisture: number
  macro: number
  /** Unit normal of the local bedding planes, shared with the mesh terracing. */
  beddingX: number
  beddingY: number
  beddingZ: number
  bedThickness: number
  /** 0..1 strength of bedding expression, shared with the mesh terracing. */
  bedExposure: number
  jointing: number
  lichen: number
  mottle: number
  beddedOffsetX: number
  beddedOffsetY: number
  beddedOffsetZ: number
  regionalTint: number
  buttress: number
  /** 0..1 proximity to a drainage line: the path water actually takes. */
  flow: number
  /** 0..1 regional climate, 0 temperate alpine to 1 true desert. */
  aridity: number
  /** 0..1 how completely a wind-blown sand sea has taken over the surface. */
  erg: number
}

/** Final broad material coverage baked into each compiled terrain vertex. */
export interface TerrainLayerWeights {
  grass: number
  meadow: number
  soil: number
  scree: number
  rock: number
  snow: number
  slope: number
  lichen: number
}

/** Metres of bed thickness the packed unit value spans. */
export const BED_THICKNESS_MIN = 9
export const BED_THICKNESS_MAX = 26

/**
 * Broad material fields, evaluated once per vertex by the section worker and
 * interpolated by the rasteriser.
 *
 * The fields that decide *what a surface is made of* are read from the terrain
 * itself — the drainage network, the local slope, the bedding attitude that the
 * mesh was terraced with — rather than from independent noise. A noise field
 * thresholded into a mask can only ever produce a plausible-looking blob; it
 * has no reason to put scree beneath a cliff, moss in a gully or a bench where
 * a resistant bed outcrops, so it produces terrain that is busy without being
 * coherent. Reading the same quantities the landform was built from costs
 * nothing extra here and is the difference.
 *
 * What remains noise-driven is only genuine small-scale material variation —
 * lichen, mottling, jointing density — where noise is the honest model.
 *
 * The Perlin implementation mirrors MaterialX's, including its Jenkins hash and
 * gradient scale, so these agree exactly with the fragment shader's own taps.
 */
export function evaluateTerrainMaterialFields(
  x: number,
  y: number,
  z: number,
  seed: number,
): TerrainMaterialFields {
  warp(x, y, z, 9.5, 0.021)
  warp(warped.x, warped.y, warped.z, 1.6, 0.1373)
  const beddedX = warped.x
  const beddedY = warped.y
  const beddedZ = warped.z
  warp(x, y, z, 11, 0.02)
  const buttressX = warped.x
  const buttressY = warped.y
  const buttressZ = warped.z

  const terrain = sampleHeightFieldCached(x, z, seed)
  const { bedding } = terrain

  // Slope from the height stack rather than the mesh normal, so it survives LOD
  // changes and skirt vertices unchanged.
  const slope = clamp(terrain.steepness, 0, 3)
  const baseNormalY = 1 / Math.sqrt(1 + slope * slope)
  const showcaseDistance = Math.hypot((x - 300) / 680, (z - 100) / 400)
  const bedrockExposure = 1 - smoothstep(0.48, 0.98, showcaseDistance)

  // Water collects in the carved drainage lines and thins out with altitude,
  // where there is less catchment above and more of the year is frozen.
  const altitudeDrying = smoothstep(210, 540, y)
  // Standing water in the basin. A closed valley floor carries no drainage, so
  // `flow` cannot see it at all, and without this the ground a few metres from
  // the river's edge is classified exactly like a dry hillside — which is what
  // turned the whole basin into tan pasture with a lake sitting in it.
  const waterTable =
    1 - smoothstep(WATER_LEVEL, WATER_LEVEL + WATER_TABLE_REACH, y)
  const flow = terrain.flow
  const { aridity, erg } = terrain
  const moisture = clamp(
    0.4 +
      flow * 0.5 +
      waterTable * 0.3 +
      (1 - smoothstep(0.45, 1.4, slope)) * 0.24 -
      altitudeDrying * 0.42 -
      // Climate enters the material system at exactly one place: it takes the
      // water away. Everything that distinguishes a desert downstream — bare
      // bedrock, unfixed sand, no turf, no moss, no wet runnels — follows from
      // that one subtraction through fields that already existed, rather than
      // from a parallel set of desert-only rules. The residue left at full
      // aridity is deliberate: even an erg has damp interdune hollows where
      // the water table is close, and those are where its only vegetation is.
      aridity * 0.55 +
      (fbm(x, y, z, 150, 2) - 0.5) * 0.3,
    0,
    1,
  )

  // How much loose material this part of the range is supplied with and can
  // keep at the catchment scale: drainage lines collect it, and whole faces
  // steep enough to shed everything supply it. The per-pixel decision about
  // whether it can rest on *this* gradient belongs to the shader, which knows
  // the real surface normal; this is only the budget it draws from.
  const deposition = clamp(
    0.62 +
      flow * 0.3 -
      smoothstep(0.9, 2.1, slope) * 0.5 +
      // A desert is not short of loose material — it is short of the water and
      // roots that would fix it in place. Sand is supplied by the weathering of
      // the sandstone itself and then moved and re-sorted by wind, so the arid
      // basins carry a *larger* budget of mobile regolith than the alpine
      // valleys do, not a smaller one.
      aridity * 0.22 +
      (fbm(x, y, z, 46, 2) - 0.5) * 0.34,
    0,
    1,
  )

  return {
    regional: perlin3(x * 0.011, y * 0.011, z * 0.011),
    baseNormalY,
    bedrockExposure,
    deposition,
    moisture,
    macro: fbm(x, y, z, 34, 3),
    beddingX: bedding.normalX,
    beddingY: bedding.normalY,
    beddingZ: bedding.normalZ,
    bedThickness: clamp(
      (bedding.thickness - BED_THICKNESS_MIN) /
        (BED_THICKNESS_MAX - BED_THICKNESS_MIN),
      0,
      1,
    ),
    bedExposure: bedding.expression,
    jointing: fbm(x, y, z, 24, 2),
    lichen: fbm(x, y, z, 9, 3),
    mottle: fbm(x, y, z, 14, 2),
    beddedOffsetX: beddedX - x,
    beddedOffsetY: beddedY - y,
    beddedOffsetZ: beddedZ - z,
    regionalTint: fbm(x, y, z, 220, 2),
    aridity,
    erg,
    buttress: ridged(buttressX, buttressY * 0.6, buttressZ, 9, 3),
    flow,
  }
}

/**
 * Evaluates the stable layer-classification portion of the full material once
 * during section compilation. The former fragment implementation ran these
 * eight Perlin taps for every covered pixel on every frame, even though the
 * inputs only change when the mesh is rebuilt.
 */
export function evaluateTerrainLayerWeights(
  x: number,
  y: number,
  z: number,
  normalY: number,
  curvature: number,
  fields: TerrainMaterialFields,
): TerrainLayerWeights {
  const slope = clamp(1 - normalY, 0, 1)
  const regional = fields.regional * 0.5

  let raw = 0
  if (slope < 0.58) {
    raw = fbm2(x + y * 0.37, z + y * 0.21, 3, 4) - 0.5
  }
  if (slope > 0.32) {
    const volumeFray = fbm(x, y, z, 3, 4) - 0.5
    raw = lerp(raw, volumeFray, smoothstep(0.32, 0.58, slope))
  }
  const fray = raw * 0.22

  const regolith = clamp(
    falloff(0.44, 0.1, slope + fray * 0.6) *
      falloff(0.85, 0.12, curvature) *
      (fields.deposition * 0.6 + 0.45) *
      // The showcase is a stripped glacial rock basin. Retaining the generic
      // meadow/regolith budget here made the fused mesh operands switch to a
      // completely different dark material at their exact join and recreated
      // the appearance of props even though the topology was continuous.
      (1 - fields.bedrockExposure * 0.84),
    0,
    1,
  )
  const rock = 1 - regolith
  const { aridity } = fields
  // Desert pavement. On temperate ground the coarse fraction only shows where
  // the gradient is steep enough to keep washing the fines out from between the
  // clasts, which is what the lower edge of `repose` encodes. An arid surface
  // gets to the same place by the opposite route and on no gradient at all:
  // wind removes the fines directly, and what it cannot lift settles into a
  // single armoured layer of varnished gravel. Lowering that edge with aridity
  // is the whole of it — flat desert floors become lag rather than clean sand,
  // and the sand goes where the wind actually piles it instead of lying
  // everywhere in an even sheet.
  const repose =
    smoothstep(0.075 - aridity * 0.07, 0.17 - aridity * 0.09, slope + fray * 0.5) *
    falloff(0.46, 0.24, slope)
  const scree =
    regolith *
    repose *
    (falloff(0.5, -0.3, curvature) * 0.7 + 0.3)
  const remaining = regolith * (1 - scree)
  const alpineFade = falloff(
    412,
    268,
    y + regional * 44 + fray * 26,
  )
  // Drying the moisture field already thins the vegetation; this closes it out.
  // The two are not redundant: moisture is a continuum that a wet gully can
  // push back up locally, and that is exactly right — a desert wash really is
  // the one green line in the landscape. But it must not push a *hillside*
  // back to pasture, so the ceiling on how much of the ground can be vegetated
  // at all comes down with the climate independently of any local wetness.
  const aridCeiling = 1 - smoothstep(0.25, 0.72, aridity) * 0.94
  const plantable =
    smoothstep(0.2, 0.52, fields.moisture + raw * 0.28) *
    alpineFade *
    aridCeiling *
    falloff(0.38, 0.1, slope + fray) *
    // This basin is the exposed mesh-patch showcase, not a pasture. Suppress
    // the generic alpine vegetation budget here so the continuous mineral
    // material remains visible on both the source terrain and inserted faces.
    (1 - fields.bedrockExposure * 0.995)
  const soil = remaining * (1 - plantable)
  const vegetated = remaining * plantable
  // Wet meadow follows the water table as much as it follows the climate: the
  // strip between the river and the foot of the slope is the greenest ground in
  // an alpine valley, and above it the same moisture reads as dry pasture.
  const waterTable =
    1 - smoothstep(WATER_LEVEL, WATER_LEVEL + WATER_TABLE_REACH, y)
  const lush = smoothstep(
    0.3,
    0.66,
    fields.moisture * 0.6 + fields.flow * 0.55 + waterTable * 0.4 + raw * 0.3,
  )
  const grass = vegetated * lush
  const meadow = vegetated * (1 - lush)

  const snowEdge = raw * 30 + curvature * -46
  const snow =
    smoothstep(
      SNOW_LINE,
      SNOW_LINE + SNOW_LINE_BAND,
      y + regional * 44 + fray * 30 + snowEdge,
    ) * falloff(0.5, 0.12, slope + snowEdge * 0.01)
  const snowFree = 1 - snow
  const lichen =
    fields.lichen *
    smoothstep(0.26, 0.7, fields.moisture) *
    falloff(0.6, -0.2, curvature)

  // --- the dune sea ------------------------------------------------------
  // Inside an erg the slope-and-curvature classification above has nothing
  // useful to say. It reads a slipface at the angle of repose as ground steep
  // enough to wash its fines out and hands back armoured pavement, which is
  // exactly backwards: a slipface is the cleanest, best-sorted sand in the
  // whole landscape, because the avalanching that built it *is* a sorting
  // process. Where the sand sea is established it simply wins, and the ordinary
  // classification fades back in around the margins as the dunes thin out onto
  // the basin floor. Snow is left alone — it is already zero at these
  // altitudes and in this climate, and making the erg fight it would only add a
  // term that can never fire.
  const sandward = smoothstep(0.12, 0.62, fields.erg)

  return {
    grass: lerp(grass * snowFree, 0, sandward),
    meadow: lerp(meadow * snowFree, 0, sandward),
    soil: lerp(soil * snowFree, snowFree, sandward),
    scree: lerp(scree * snowFree, 0, sandward),
    rock: lerp(rock * snowFree, 0, sandward),
    snow,
    slope,
    lichen: lerp(lichen, 0, sandward),
  }
}

function fbm(
  x: number,
  y: number,
  z: number,
  wavelength: number,
  octaves: number,
): number {
  let sum = 0
  let total = 0.0001
  let amplitude = 1
  let scale = 1 / wavelength
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += perlin3(x * scale, y * scale, z * scale) * amplitude
    total += amplitude
    amplitude *= 0.52
    scale *= 2.07
  }
  return clamp(sum / total * 0.5 + 0.5, 0, 1)
}

function fbm2(
  x: number,
  y: number,
  wavelength: number,
  octaves: number,
): number {
  let sum = 0
  let total = 0.0001
  let amplitude = 1
  let scale = 1 / wavelength
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += perlin2(x * scale, y * scale) * amplitude
    total += amplitude
    amplitude *= 0.52
    scale *= 2.07
  }
  return clamp(sum / total * 0.5 + 0.5, 0, 1)
}

function ridged(
  x: number,
  y: number,
  z: number,
  wavelength: number,
  octaves: number,
): number {
  let sum = 0
  let total = 0.0001
  let amplitude = 1
  let scale = 1 / wavelength
  let carry = 1
  for (let octave = 0; octave < octaves; octave += 1) {
    const ridge = 1 - Math.abs(perlin3(x * scale, y * scale, z * scale))
    const shaped = ridge * ridge * carry
    carry = clamp(shaped * 2.1, 0, 1)
    sum += shaped * amplitude
    total += amplitude
    amplitude *= 0.55
    scale *= 2.07
  }
  return clamp(sum / total, 0, 1)
}

/**
 * Domain warp, written into `warped` rather than returned.
 *
 * This is called three times for every vertex of every section, and the object
 * it used to return -- along with the `Point3` wrappers the noise stack took --
 * was allocated and collected purely to carry three numbers a few lines. The
 * caller reads the result immediately, so one module-level triple serves.
 */
const warped = { x: 0, y: 0, z: 0 }

function warp(
  x: number,
  y: number,
  z: number,
  amount: number,
  frequency: number,
): void {
  const sx = x * frequency
  const sy = y * frequency
  const sz = z * frequency
  const a = perlin3(sx, sy, sz)
  const b = perlin3(
    sy * -1.13 + 19.7,
    sz * -1.13 + 19.7,
    sx * -1.13 + 19.7,
  )
  warped.x = x + a * amount
  warped.y = y + b * amount
  warped.z = z + (a * 0.7 - b * 0.7) * amount
}

function perlin3(x: number, y: number, z: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const u = fade(fx)
  const v = fade(fy)
  const w = fade(fz)

  const n000 = gradient(hash3(ix, iy, iz), fx, fy, fz)
  const n100 = gradient(hash3(ix + 1, iy, iz), fx - 1, fy, fz)
  const n010 = gradient(hash3(ix, iy + 1, iz), fx, fy - 1, fz)
  const n110 = gradient(hash3(ix + 1, iy + 1, iz), fx - 1, fy - 1, fz)
  const n001 = gradient(hash3(ix, iy, iz + 1), fx, fy, fz - 1)
  const n101 = gradient(hash3(ix + 1, iy, iz + 1), fx - 1, fy, fz - 1)
  const n011 = gradient(hash3(ix, iy + 1, iz + 1), fx, fy - 1, fz - 1)
  const n111 = gradient(hash3(ix + 1, iy + 1, iz + 1), fx - 1, fy - 1, fz - 1)

  const x00 = lerp(n000, n100, u)
  const x10 = lerp(n010, n110, u)
  const x01 = lerp(n001, n101, u)
  const x11 = lerp(n011, n111, u)
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 0.982
}

function perlin2(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const u = fade(fx)
  const v = fade(fy)

  const n00 = gradient2(hash2(ix, iy), fx, fy)
  const n10 = gradient2(hash2(ix + 1, iy), fx - 1, fy)
  const n01 = gradient2(hash2(ix, iy + 1), fx, fy - 1)
  const n11 = gradient2(hash2(ix + 1, iy + 1), fx - 1, fy - 1)
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 0.6616
}

function gradient2(hash: number, x: number, y: number): number {
  const h = hash & 7
  const u = h < 4 ? x : y
  const v = 2 * (h < 4 ? y : x)
  return (h & 1 ? -u : u) + (h & 2 ? -v : v)
}

/**
 * The sixteen gradient directions Perlin's `grad` selects between, tabulated.
 *
 * The classic formulation picks its two axes and their two signs with four
 * branches, and `perlin3` runs it once per cube corner -- forty unpredictable
 * branches per tap, against roughly thirty taps per vertex. Each of those cases
 * is a dot product with a fixed vector, so reading the vector out of a table
 * computes exactly the same number without any of the branching. The values are
 * the branching form's own output for the three basis vectors.
 */
const GRADIENT_X = /*@__PURE__*/ Float64Array.from(
  [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, 0, -1, 0],
)
const GRADIENT_Y = /*@__PURE__*/ Float64Array.from(
  [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1],
)
const GRADIENT_Z = /*@__PURE__*/ Float64Array.from(
  [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 1, 0, -1],
)

function gradient(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15
  return GRADIENT_X[h] * x + GRADIENT_Y[h] * y + GRADIENT_Z[h] * z
}

function hash3(x: number, y: number, z: number): number {
  const seed = (0xdeadbeef + (3 << 2) + 13) >>> 0
  return bjFinal(
    (seed + (x >>> 0)) >>> 0,
    (seed + (y >>> 0)) >>> 0,
    (seed + (z >>> 0)) >>> 0,
  )
}

function hash2(x: number, y: number): number {
  const seed = (0xdeadbeef + (2 << 2) + 13) >>> 0
  return bjFinal(
    (seed + (x >>> 0)) >>> 0,
    (seed + (y >>> 0)) >>> 0,
    seed,
  )
}

function falloff(high: number, low: number, value: number): number {
  return 1 - smoothstep(low, high, value)
}

function bjFinal(initialA: number, initialB: number, initialC: number): number {
  let a = initialA >>> 0
  let b = initialB >>> 0
  let c = initialC >>> 0
  c = (c ^ b) >>> 0
  c = (c - rotateLeft(b, 14)) >>> 0
  a = (a ^ c) >>> 0
  a = (a - rotateLeft(c, 11)) >>> 0
  b = (b ^ a) >>> 0
  b = (b - rotateLeft(a, 25)) >>> 0
  c = (c ^ b) >>> 0
  c = (c - rotateLeft(b, 16)) >>> 0
  a = (a ^ c) >>> 0
  a = (a - rotateLeft(c, 4)) >>> 0
  b = (b ^ a) >>> 0
  b = (b - rotateLeft(a, 14)) >>> 0
  c = (c ^ b) >>> 0
  return (c - rotateLeft(b, 24)) >>> 0
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function fade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10)
}

function lerp(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}
