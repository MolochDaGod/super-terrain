import {
  ALPINE_TURF_ALTITUDE,
  FELLFIELD_ALTITUDE,
  MONTANE_ALTITUDE,
  SNOW_LINE,
  SNOW_LINE_BAND,
  SUMMIT_ALTITUDE,
  TREE_LINE_ALTITUDE,
  WATER_LEVEL,
  WATER_TABLE_REACH,
} from './climate'
import { clamp, smoothstep } from '../core/bounds'
import { sampleHeightFieldCached } from './heightField'

/**
 * The half of the material fields that decides *whether something grows*.
 *
 * Split out from the full set because two very different callers need it. The
 * section compiler wants everything, once per vertex, in a worker. The foliage
 * system wants only this, sixty-five thousand times, on the main thread,
 * whenever the ground-cover window moves — and the geology half it does not
 * want (three domain warps, the bedding solve, four more noise octaves for
 * jointing, mottle and regional tint) is about four fifths of the cost.
 *
 * Sharing the implementation rather than approximating it in the foliage layer
 * is the whole point. A plant that grows where the shader paints rock, or bare
 * ground the shader paints as pasture, is the single most visible failure this
 * system can have, and it is guaranteed the moment two pieces of code hold
 * their own opinion about where grass belongs.
 */
export interface TerrainVegetationFields {
  regional: number
  /** Up component of the undeformed height-field normal at this X/Z. */
  baseNormalY: number
  /**
   * 0..1 how strongly this point sits on a talus fan: below a face, on ground
   * gentle enough for the debris off that face to come to rest.
   */
  talus: number
  /**
   * 0..1 frost shattering. Above the fellfield limit the rock is not weathered
   * so much as taken apart, and what covers it is its own angular debris.
   */
  frostShatter: number
  /** Regolith depth proxy in 0..1: where loose material can come to rest. */
  deposition: number
  /** Ground water availability in 0..1, from drainage and altitude. */
  moisture: number
  /** 0..1 proximity to a drainage line: the path water actually takes. */
  flow: number
  /** 0..1 regional climate, 0 temperate alpine to 1 true desert. */
  aridity: number
  /** 0..1 how completely a wind-blown sand sea has taken over the surface. */
  erg: number
  lichen: number
}

/** Everything a compiled vertex carries: the above, plus the geology. */
export interface TerrainMaterialFields extends TerrainVegetationFields {
  macro: number
  /** Unit normal of the local bedding planes, shared with the mesh terracing. */
  beddingX: number
  beddingY: number
  beddingZ: number
  bedThickness: number
  /** 0..1 strength of bedding expression, shared with the mesh terracing. */
  bedExposure: number
  jointing: number
  mottle: number
  beddedOffsetX: number
  beddedOffsetY: number
  beddedOffsetZ: number
  regionalTint: number
  buttress: number
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

/**
 * How far uphill the talus probe looks for a supplying face, in metres.
 *
 * A fan is roughly as long as the face above it is high, and the faces in this
 * world's cliff bands run twenty to fifty metres. Probing much further finds
 * the ridge behind the cliff and puts fans on ground the cliff cannot reach;
 * much closer and the probe never clears the fan's own head.
 */
const TALUS_REACH = 46

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
export function evaluateTerrainVegetationFields(
  x: number,
  y: number,
  z: number,
  seed: number,
  /**
   * Unit XZ bearing pointing uphill, from the mesh normal. Zero where the
   * caller has none, which disables the talus probe rather than guessing a
   * direction — an arbitrary bearing would put fans on the wrong side of every
   * ridge, which is worse than having none.
   */
  upslopeX = 0,
  upslopeZ = 0,
): TerrainVegetationFields {
  const terrain = sampleHeightFieldCached(x, z, seed)

  // Slope from the height stack rather than the mesh normal, so it survives LOD
  // changes and skirt vertices unchanged.
  const slope = clamp(terrain.steepness, 0, 3)
  const baseNormalY = 1 / Math.sqrt(1 + slope * slope)

  // --- talus -------------------------------------------------------------
  //
  // Scree does not appear wherever the gradient happens to be right; it appears
  // *below a face*, because that is where the material comes from. Slope and
  // curvature alone cannot tell a cliff foot from any other concave hollow, so
  // the classifier used to dust debris evenly over every moderate slope in the
  // range — which is the difference between a mountain that sheds rock and a
  // mountain with grey patches on it.
  //
  // One probe answers it. The mesh normal gives the upslope bearing for free,
  // so a single height-field sample a fan-length uphill says whether there is
  // anything up there steep enough to supply this ground. It is skipped
  // entirely on the two thirds of the world that cannot carry a fan at any
  // supply — ground too flat to receive one, and faces too steep to hold it —
  // so the average cost is a fraction of the one sample it looks like.
  let talus = 0
  const receptive =
    smoothstep(0.16, 0.42, slope) * (1 - smoothstep(0.95, 1.55, slope))
  if (receptive > 0.02 && (upslopeX !== 0 || upslopeZ !== 0)) {
    const source = sampleHeightFieldCached(
      x + upslopeX * TALUS_REACH,
      z + upslopeZ * TALUS_REACH,
      seed,
    )
    // The face has to be both steep enough to shed and high enough above this
    // ground for the debris to have travelled. A steep patch level with the
    // sample point is a rib, not a supply.
    const relief = smoothstep(6, 34, source.height - y)
    talus = smoothstep(1.0, 2.2, source.steepness) * relief * receptive
  }

  // Above the fellfield limit the freeze-thaw cycle crosses zero often enough
  // to take the bedrock apart faster than anything can weather or colonise it.
  const frostShatter = smoothstep(
    FELLFIELD_ALTITUDE,
    SUMMIT_ALTITUDE,
    y + (fbm(x, y, z, 90, 2) - 0.5) * 40,
  )

  // Water collects in the carved drainage lines and thins out with altitude,
  // where there is less catchment above and more of the year is frozen.
  // Water thins out with altitude: less catchment above, more of the year
  // frozen. Tied to the zone boundaries so it tracks the world's own relief
  // rather than a pair of metres borrowed from a range ten times this size.
  const altitudeDrying = smoothstep(MONTANE_ALTITUDE, FELLFIELD_ALTITUDE, y)
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
      // A fan *is* a supply of loose material — that is what makes it a fan.
      talus * 0.55 +
      // Frost-shattered ground makes its own debris in place.
      frostShatter * 0.3 +
      (fbm(x, y, z, 46, 2) - 0.5) * 0.34,
    0,
    1,
  )

  return {
    regional: perlin3(x * 0.011, y * 0.011, z * 0.011),
    baseNormalY,
    talus,
    frostShatter,
    deposition,
    moisture,
    flow,
    aridity,
    erg,
    lichen: fbm(x, y, z, 9, 3),
  }
}

/**
 * Everything a compiled vertex carries. The vegetation half above, plus the
 * geology the shader needs and nothing else does.
 */
export function evaluateTerrainMaterialFields(
  x: number,
  y: number,
  z: number,
  seed: number,
  upslopeX = 0,
  upslopeZ = 0,
): TerrainMaterialFields {
  const vegetation = evaluateTerrainVegetationFields(
    x,
    y,
    z,
    seed,
    upslopeX,
    upslopeZ,
  )

  warp(x, y, z, 9.5, 0.021)
  warp(warped.x, warped.y, warped.z, 1.6, 0.1373)
  const beddedX = warped.x
  const beddedY = warped.y
  const beddedZ = warped.z
  warp(x, y, z, 11, 0.02)
  const buttressX = warped.x
  const buttressY = warped.y
  const buttressZ = warped.z

  const { bedding } = sampleHeightFieldCached(x, z, seed)

  return {
    ...vegetation,
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
    mottle: fbm(x, y, z, 14, 2),
    beddedOffsetX: beddedX - x,
    beddedOffsetY: beddedY - y,
    beddedOffsetZ: beddedZ - z,
    regionalTint: fbm(x, y, z, 220, 2),
    buttress: ridged(buttressX, buttressY * 0.6, buttressZ, 9, 3),
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
  fields: TerrainVegetationFields,
  /**
   * 1 where this surface was cut by CSG rather than weathered out of the height
   * field. Freshly exposed rock carries neither soil nor plants.
   */
  freshRock = 0,
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
      // Nothing has come to rest on a face that was cut this morning.
      (1 - freshRock * 0.88),
    0,
    1,
  )
  const { aridity } = fields
  // Total loose cover over the bedrock, and what is left showing through it.
  //
  // `regolith` alone answers "can loose material rest on this gradient", which
  // is the right question for a hillside weathering in place and the wrong one
  // for the two cases that matter most on a mountain. A talus fan is loose
  // ground on a slope that could never have produced it, and a frost-shattered
  // crest is loose ground on a summit with no catchment above it at all. Both
  // are supplied rather than retained, so they raise the mantle rather than
  // being scaled by it — and taking the maximum, not the sum, keeps the cover
  // a coverage: three ways of arriving at buried bedrock do not bury it twice.
  const mantle = clamp(
    Math.max(
      regolith,
      fields.talus * 0.86,
      fields.frostShatter * 0.78,
    ),
    0,
    1,
  )
  const rock = 1 - mantle
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
  // A fan overrides the general repose rule rather than being scaled by it: the
  // material is arriving from above regardless of whether this particular
  // gradient would have washed its own fines out, which is exactly why a fan
  // stands out as a pale tongue against the slope it is lying on.
  const fan = fields.talus * (falloff(0.62, -0.4, curvature) * 0.55 + 0.45)
  // How much of the mantle is coarse rather than fine. A fan is nothing but
  // coarse — sorting during transport is what a fan does — and frost debris is
  // angular by definition, so both push this hard toward one without having to
  // argue with the gradient the way the general repose rule does.
  const coarse = clamp(
    repose * (falloff(0.5, -0.3, curvature) * 0.7 + 0.3) +
      fan * 0.95 +
      // Frost debris has no fine fraction to speak of: the rock is being split
      // along joints, not weathered to soil. Leaving this low put a fifth of
      // every summit into the soil channel, which shaded as brown earth on
      // ground that should be nothing but angular blocks.
      fields.frostShatter * 1.15,
    0,
    1,
  )
  const scree = mantle * coarse
  const remaining = mantle * (1 - coarse)
  // --- altitude zonation ---------------------------------------------------
  //
  // The band the eye actually reads a mountain by. This used to be a single
  // fade from 268 m to 412 m, which in a world whose ground is at 1 m and whose
  // summits reach 391 m meant the entire massif — floor to crest — sat inside
  // one band and the fade never fired. A hillside and a summit were classified
  // identically, so they shaded identically, and no amount of detail on top of
  // that can make relief legible.
  //
  // Three overlapping steps instead of one. Below the treeline vegetation is
  // limited only by moisture and slope; between the treeline and the turf limit
  // the ground is still continuously covered but by turf alone; above that it
  // breaks into fellfield cushions and then fails altogether. The jitter is
  // large on purpose — a zone boundary that follows a contour exactly is the
  // loudest tell there is, and real treelines run hundreds of metres up a
  // sheltered gully and down an exposed spur.
  const zoneAltitude = y + regional * 44 + fray * 26
  const belowTreeLine = falloff(ALPINE_TURF_ALTITUDE, TREE_LINE_ALTITUDE, zoneAltitude)
  const belowFellfield = falloff(FELLFIELD_ALTITUDE, ALPINE_TURF_ALTITUDE, zoneAltitude)
  const alpineFade = belowTreeLine * 0.62 + belowFellfield * 0.38
  // Drying the moisture field already thins the vegetation; this closes it out.
  // The two are not redundant: moisture is a continuum that a wet gully can
  // push back up locally, and that is exactly right — a desert wash really is
  // the one green line in the landscape. But it must not push a *hillside*
  // back to pasture, so the ceiling on how much of the ground can be vegetated
  // at all comes down with the climate independently of any local wetness.
  const aridCeiling = 1 - smoothstep(0.25, 0.72, aridity) * 0.94
  // Plants need something to root in, not just water.
  //
  // Without this the classifier put vegetation on every gentle, damp square
  // metre it could find, and since the valley floor is both, the floor came out
  // as an unbroken lawn with three per cent bare ground in it. Real pasture is
  // seventy to eighty-five per cent covered: the rest is the scars, gravel
  // bars, worn ground and thin patches over shallow bedrock that the regolith
  // budget already describes. Reading coverage off `deposition` gets all of
  // those for free and at the right scale — its 46 m wavelength is exactly the
  // size of a bare patch on a hillside — instead of from a mask invented here.
  // Rooting depth matters far less where the water table is at the surface: a
  // marsh or a streamside flat carries continuous sedge over almost no soil,
  // while the same regolith depth on a dry hillside grows very little. Without
  // the moisture term the gate turned wet valley floors — the greenest ground
  // in the world — into bare mud wherever the deposition noise dipped.
  const rootable = smoothstep(
    0.34,
    0.78,
    fields.deposition + raw * 0.34 + fields.moisture * 0.15,
  )
  // Pasture is never a closed lawn.
  //
  // Even the best of it runs seventy to eighty-five per cent cover: the rest is
  // the scuffs, stock paths, gravel, ant hills and thin ground over shallow
  // rock that every real hillside carries. Left uncapped the classifier hands
  // back ground that is a hundred per cent vegetated over square kilometres,
  // and a hundred per cent of one thing is what makes terrain read as painted
  // no matter how good the material shading it is. This is also what leaves
  // room for the forest to be the thing that clothes a slope, with grass in the
  // clearings and along the water rather than everywhere at once.
  //
  // Kept close to one, though, and the first attempt at 0.78 shows why: every
  // point of cover taken off `plantable` is handed straight to `soil`, so a
  // fifth off the top turned the valley floor into forty per cent bare earth —
  // a mud world, which is no more real than a lawn. The gaps *within* a sward
  // are not a separate material and must not be classified as one; they are
  // what `swardThinning` draws in the shader, at the scale of the tussocks they
  // sit between. This slot only carries ground that is genuinely unvegetated.
  const CLOSED_COVER = 0.92
  const plantable =
    CLOSED_COVER *
    smoothstep(0.2, 0.52, fields.moisture + raw * 0.28) *
    rootable *
    alpineFade *
    aridCeiling *
    falloff(0.38, 0.1, slope + fray) *
    // Nothing colonises ground that is being taken apart by frost faster than
    // it can be rooted in, and nothing has had time to colonise a fresh cut.
    (1 - fields.frostShatter * 0.92) *
    (1 - freshRock * 0.985)
  const soil = remaining * (1 - plantable)
  const vegetated = remaining * plantable
  // Wet meadow follows the water table as much as it follows the climate: the
  // strip between the river and the foot of the slope is the greenest ground in
  // an alpine valley, and above it the same moisture reads as dry pasture.
  const waterTable =
    1 - smoothstep(WATER_LEVEL, WATER_LEVEL + WATER_TABLE_REACH, y)
  const lush =
    smoothstep(
      0.42,
      0.86,
      fields.moisture * 0.6 + fields.flow * 0.55 + waterTable * 0.4 + raw * 0.3,
    ) *
    // Alpine turf above the treeline is tussock and cushion, never lush
    // pasture, however wet it is — the growing season is too short. Without
    // this the wet gullies that run down off a summit stay bright green all the
    // way to the crest, which is the one thing that most reliably flattens a
    // high ridge back into a hill.
    belowTreeLine
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
