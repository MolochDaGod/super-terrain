import {
  If,
  attribute,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  floor,
  max,
  mix,
  normalize,
  smoothstep,
  vec2,
  vec3,
  vec4,
  varying,
} from 'three/tsl'
import {
  cells,
  cells2,
  detailDeadFootprint,
  detailFade,
  fadeToMean,
  falloff,
  fbm1,
  fbmLodBands,
  lodDeadFootprint,
  ridgedLod,
  warp,
  warp2,
} from './fields'
import {
  BED_THICKNESS_MAX,
  BED_THICKNESS_MIN,
} from '../../compiler/TerrainMaterialFields'

/**
 * The auto-material.
 *
 * Layer selection is driven only by geometry (slope, altitude, convexity) plus
 * slow world-space noise, so it is stable under editing and identical across
 * LOD swaps. Layers are then combined by *height* rather than by a linear
 * cross-fade: each layer carries a relief height, and the topmost surface wins
 * per-pixel. That is what makes scree appear to sit in the grass instead of
 * being painted over it.
 *
 * Relief is built in three explicit scale bands rather than one noise field:
 *
 *   macro (8–40 m)  outcrops, erosion gullies, bench edges — visible to 2 km
 *   meso  (0.8–6 m) rock blocks, boulders, turf hummocks  — visible to ~400 m
 *   micro (3–40 cm) cracks, pits, pebbles, grass clumps   — visible to ~40 m
 *
 * Each band is band-limited against the pixel footprint, so it contributes
 * shading right up to the distance where it would start to alias and then
 * dissolves into its own mean instead of into grey mush.
 */

export interface SurfaceLayer {
  name: string
  /** Linear-space base albedo. */
  albedo: [number, number, number]
  roughness: number
  /** Metres of relief this layer contributes. */
  relief: number
}

/**
 * Measured diffuse reflectances, linear.
 *
 * These are the real numbers — weathered limestone genuinely reflects about a
 * third of the light that falls on it, and alpine turf about a twelfth. The
 * previous values were three to five times darker across the board, which is
 * survivable in isolation because exposure can be raised to compensate, but not
 * in a scene with a physical sky: the compensation has to come from somewhere,
 * and it came from a sun bright enough to blow out the snow and a haze that had
 * to be thinned until it stopped separating the ridges. Getting the
 * reflectances right is what lets every other quantity be right as well.
 */
export const SURFACE_LAYERS = {
  grass: { name: 'grass', albedo: [0.052, 0.079, 0.031], roughness: 0.94, relief: 0.11 },
  meadow: { name: 'meadow', albedo: [0.148, 0.126, 0.061], roughness: 0.92, relief: 0.09 },
  soil: { name: 'soil', albedo: [0.105, 0.082, 0.058], roughness: 0.9, relief: 0.04 },
  scree: { name: 'scree', albedo: [0.155, 0.148, 0.132], roughness: 0.87, relief: 0.2 },
  rock: { name: 'rock', albedo: [0.265, 0.258, 0.238], roughness: 0.84, relief: 0.55 },
  snow: { name: 'snow', albedo: [0.7, 0.73, 0.78], roughness: 0.7, relief: 0.14 },
} satisfies Record<string, SurfaceLayer>

/**
 * The same six roles, in an arid climate.
 *
 * A biome here is not a new set of layers — it is the same six slots with
 * different matter in them. Coverage is still decided upstream from slope,
 * curvature and deposition, and that code neither knows nor needs to know what
 * the climate is; all that changes is what the ground turns out to be made of
 * once the water has been taken away. Turf thins to desert scrub and then to
 * bare sand, alpine talus becomes varnished pavement, and the bedrock beneath
 * is a sandstone sequence rather than a granite-carbonate one.
 *
 * Keeping the roles fixed is what lets the two climates cross-fade at all. A
 * biome that owned its own layer list would have to blend coverage between two
 * different classifications at the margin, and the margin is thousands of
 * metres wide.
 *
 * Reflectances measured as above: dry quartz sand really does return about a
 * third of the light falling on it, which makes a desert floor at noon the
 * brightest natural surface in a scene short of fresh snow.
 */
export const ARID_SURFACE_LAYERS = {
  grass: { name: 'wash', albedo: [0.086, 0.092, 0.046], roughness: 0.93, relief: 0.1 },
  meadow: { name: 'scrub', albedo: [0.162, 0.142, 0.086], roughness: 0.93, relief: 0.12 },
  soil: { name: 'sand', albedo: [0.335, 0.268, 0.171], roughness: 0.96, relief: 0.05 },
  scree: { name: 'pavement', albedo: [0.138, 0.116, 0.089], roughness: 0.88, relief: 0.16 },
  rock: { name: 'sandstone', albedo: [0.325, 0.246, 0.163], roughness: 0.88, relief: 0.6 },
  snow: { name: 'snow', albedo: [0.7, 0.73, 0.78], roughness: 0.7, relief: 0.14 },
} satisfies Record<string, SurfaceLayer>

/**
 * Climate blend used by every biome-dependent term.
 *
 * Shared so the shading, the roughness and the relief all cross over at the
 * same place. Splitting the thresholds — even slightly — puts sandstone colour
 * on ground that still carries alpine relief for a kilometre of the margin.
 */
function aridBlend(slow: TerrainSlowFields): any {
  return smoothstep(0.25, 0.75, slow.aridity)
}

/**
 * World sizes of the detail bands, in metres.
 *
 * Each is used twice: once to band-limit the effect against the pixel footprint
 * and once to place the branch that skips it. Both readings come from the same
 * constant so a change to one cannot silently leave the other behind.
 */
const BLOCK_SIZE = 1.8
const CRACK_WAVELENGTH = 0.9
const CLUMP_WAVELENGTH = 0.34
const BLADE_WAVELENGTH = CLUMP_WAVELENGTH / 2.07 ** 2
const PEBBLE_SIZE = 0.16
const LOOSE_STONE_SIZE = 0.28
/**
 * Wind ripples on dune sand, metres crest to crest.
 *
 * Ripples are the finest thing in this shader that still reads at a distance,
 * and they read for a reason no other micro band does: they are *organised*.
 * Every crest in a patch is parallel to every other, so instead of averaging
 * into flat grey as they pass below a pixel they average into a directional
 * sheen that changes with the sun. That is why a dune photographed from a
 * kilometre away still looks like sand rather than like a smooth grey hill.
 */
const RIPPLE_WAVELENGTH = 0.26
/** Width of a grainflow tongue on a slipface, metres. */
const GRAINFLOW_WIDTH = 1.4
/**
 * The wind that orders every aeolian bedform, as a unit vector in world XZ.
 *
 * This is a constant, and it has to be. The tempting version derives the ripple
 * direction per pixel from the surface normal, so that crests follow the
 * contour of the dune and curl correctly around a barchan horn. It produces
 * catastrophic moire, and the reason is worth stating because nothing about the
 * expression looks dangerous:
 *
 *   phase = dot(position.xz, axis) / wavelength
 *
 * If `axis` varies with position, the gradient of that dot product is not
 * `axis` but `axis + (d axis/d x)^T . position`. World positions here run to
 * eight kilometres, so an axis wobble of a hundredth of a radian — far less
 * than the normal varies across a single ripple — moves the projection by fifty
 * metres, which is two hundred wavelengths. The true spatial frequency explodes
 * while `detailFade` still believes the feature is 26 cm across and declines to
 * band-limit anything, and the aliased phase then feeds the shading normal.
 *
 * A constant axis makes the gradient exactly `axis / wavelength`, which is what
 * every fade in this file assumes. It also costs nothing physically: one wind
 * builds one dune field, ripples are oriented by that wind, and the crest of a
 * transverse dune is already perpendicular to it — so contour-parallel ripples
 * are what a fixed downwind bearing gives on the ramps anyway. The bearing is
 * the middle of the range the compiler's own dune wind drifts across.
 */
const WIND_AXIS = /*@__PURE__*/ vec2(0.362, 0.932)
/** Across-wind, i.e. along a ripple crest. */
const CREST_AXIS = /*@__PURE__*/ vec2(-0.932, 0.362)

/** Blend sharpness for the height-based layer resolve, in metres. */
const HEIGHT_BLEND_DEPTH = 0.14
/**
 * How far coverage outranks relief in the layer contest, in metres of relief.
 * Layers whose coverage differs by more than `HEIGHT_BLEND_DEPTH / COVERAGE_BIAS`
 * are decided by coverage alone; closer than that, relief decides and the two
 * interlock.
 */
const COVERAGE_BIAS = 0.38

export interface LayerWeights {
  grass: any
  meadow: any
  soil: any
  scree: any
  rock: any
  snow: any
  /** Slope in [0, 1]: 0 flat, 1 vertical. */
  slope: any
  /** Large-scale wetness that drives lush vs. dry vegetation. */
  moisture: any
  /** Lichen/moss coverage on rock. */
  lichen: any
}

/**
 * Broad fields evaluated per vertex and smoothly interpolated for fragments.
 * Their shortest wavelength is still several times larger than a close LOD
 * triangle; at coarser LODs the interpolation is also the correct low-pass
 * filter. This preserves the field while avoiding millions of identical slow
 * noise evaluations in the fragment stage.
 */
export interface TerrainSlowFields {
  moisture: any
  grass: any
  meadow: any
  soil: any
  scree: any
  rock: any
  snow: any
  bakedLichen: any
  /** Unit normal of the bedding planes the mesh itself was terraced along. */
  beddingNormal: any
  bedThickness: any
  bedExposure: any
  jointing: any
  /** Regional climate, 0 temperate alpine to 1 true desert. */
  aridity: any
  macro: any
  /** Signed mean curvature: +1 convex rib, -1 concave hollow. */
  curvature: any
  bedded: any
  buttress: any
  /** CSG-authored emissive chamber surface; never a separate render mesh. */
  ember: any
  mottle: any
  regionalTint: any
  occlusion: any
  /** Proximity to a drainage line, from the carved network. */
  flow: any
}

export function terrainSlowFields(position: any): TerrainSlowFields {
  // Coverage needs six interpolated values, but WebGPU guarantees only eight
  // vertex buffers and the material already uses all of them. Decode two u8
  // fields from each normalized u16 component in the vertex stage, then pass
  // the individual values to fragments as ordinary varyings. This keeps the
  // existing five-buffer geometry layout and is amply precise for soft masks.
  const layerAttribute = vec4(attribute('terrainSurface0', 'vec4') as any)
  const grassMeadow = unpackUnitPair(layerAttribute.x)
  const soilScree = unpackUnitPair(layerAttribute.y)
  const rockSnow = unpackUnitPair(layerAttribute.z)
  const bakedCoverage = varying(
    vec4(grassMeadow.low, grassMeadow.high, soilScree.low, soilScree.high),
    'terrainBakedCoverage',
  )
  const bakedCoverageAndMacro = varying(
    vec4(rockSnow.low, rockSnow.high, layerAttribute.w, 0),
    'terrainBakedCoverageAndMacro',
  )
  const bedding = varying(
    vec4(attribute('terrainSurface1', 'vec4') as any),
    'terrainSlowBedding',
  )
  const materialAttribute = vec4(attribute('terrainSurface2', 'vec4') as any)
  const moistureLichen = unpackUnitPair(materialAttribute.y)
  // Both halves of a packed pair have to be split in the vertex stage. The
  // packing is not linear across the seam between the two bytes, so
  // interpolating the packed word and unpacking afterwards would produce a
  // value that sweeps the whole range wherever the low byte wraps.
  const mottleAridity = unpackUnitPair(materialAttribute.w)
  const material = varying(
    materialAttribute,
    'terrainSlowMaterial',
  )
  const bakedMoistureLichen = varying(
    vec4(
      moistureLichen.low,
      moistureLichen.high,
      mottleAridity.low,
      mottleAridity.high,
    ),
    'terrainBakedMoistureLichen',
  )
  const warpedAndTint = varying(
    vec4(attribute('terrainSurface3', 'vec4') as any),
    'terrainSlowWarp',
  )
  const reliefAttribute = vec4(attribute('terrainSurface4', 'vec4') as any)
  const buttressEmber = unpackUnitPair(reliefAttribute.x)
  const relief = varying(
    vec4(
      buttressEmber.low,
      reliefAttribute.y,
      reliefAttribute.z,
      reliefAttribute.w,
    ),
    'terrainSlowRelief',
  )
  const bakedEmber = varying(buttressEmber.high, 'terrainBakedEmber')
  return {
    grass: bakedCoverage.x,
    meadow: bakedCoverage.y,
    soil: bakedCoverage.z,
    scree: bakedCoverage.w,
    rock: bakedCoverageAndMacro.x,
    snow: bakedCoverageAndMacro.y,
    macro: bakedCoverageAndMacro.z,
    moisture: bakedMoistureLichen.x,
    bakedLichen: bakedMoistureLichen.y,
    // Interpolating the plane normal directly avoids the wrap discontinuity an
    // interpolated strike azimuth would carry across every 360-degree seam.
    beddingNormal: normalize(bedding.xyz.mul(2).sub(1)),
    bedThickness: mix(
      float(BED_THICKNESS_MIN),
      float(BED_THICKNESS_MAX),
      bedding.w,
    ),
    bedExposure: relief.w,
    jointing: material.x,
    curvature: material.z.mul(2).sub(1),
    mottle: bakedMoistureLichen.z,
    aridity: bakedMoistureLichen.w,
    bedded: position.add(warpedAndTint.xyz.mul(2).sub(1).mul(16)),
    regionalTint: warpedAndTint.w,
    buttress: relief.x,
    ember: bakedEmber,
    occlusion: relief.y,
    flow: relief.z,
  }
}

function unpackUnitPair(packed: any): { low: any; high: any } {
  const bits = floor(packed.mul(65_535).add(0.5))
  const highByte = floor(bits.div(256))
  return {
    low: bits.sub(highByte.mul(256)).div(255),
    high: highByte.div(255),
  }
}

/**
 * Layer coverage is compiled from the physical state of the ground by the
 * terrain worker. Rendering only interpolates those stable results; the cheap
 * slope expression stays here because double-sided tunnel faces must flip the
 * normal according to the face being drawn.
 */
export function layerWeights(normal: any, slow: TerrainSlowFields): LayerWeights {
  return {
    grass: slow.grass,
    meadow: slow.meadow,
    soil: slow.soil,
    scree: slow.scree,
    rock: slow.rock,
    snow: slow.snow,
    slope: clamp(normal.y.oneMinus(), 0, 1),
    moisture: slow.moisture,
    lichen: slow.bakedLichen,
  }
}

export interface SurfaceDetail {
  /** Combined relief height in metres, used for blending and parallax. */
  height: any
  /** Relief bands that bend the normal, assembled from the shared evaluation. */
  normalHeight: any
  /** Resolved, height-blended per-layer weights (sum to 1). */
  resolved: Record<string, any>
  /** Per-layer detail values reused for albedo shading. */
  detail: {
    strata: any
    crossBedding: any
    arid: any
    ripple: any
    grainflow: any
    slipface: any
    bedHardness: any
    bedProfile: any
    bedStep: any
    bedExposure: any
    bedProud: any
    crack: any
    blocks: any
    buttress: any
    pebble: any
    pebbleId: any
    clump: any
    blade: any
    looseStone: any
    macro: any
    outcrop: any
  }
}

/**
 * Evaluates relief and resolves the layer stack at a world position.
 * `footprint` is the world-space size of one pixel and band-limits every scale,
 * so this can be called at any distance without shimmering.
 */
export function surfaceDetail(
  position: any,
  normal: any,
  weights: LayerWeights,
  footprint: any,
  slow: TerrainSlowFields,
): SurfaceDetail {
  const rockyCoverage = weights.rock.add(weights.scree).toVar('rockyCoverage')
  const turfCoverage = weights.grass
    .add(weights.meadow)
    .add(weights.soil)
    .toVar('turfCoverage')
  const groundCoverage = turfCoverage
    .add(weights.scree)
    .add(weights.snow)
    .clamp(0, 1)
    .toVar('groundCoverage')

  // --- macro band: survives to the horizon --------------------------------
  const macro = slow.macro.toVar('macroField')
  // Erosion runnels down the fall line: the strongest large-scale cue that a
  // slope is rock and not a smooth heightmap.
  const outcrop = float(0.5).toVar('outcrop')

  // --- strata: continuous bedding planes ---------------------------------
  // Banding is a function of world height (plus a tilt and a slow warp), so a
  // band stays continuous across a whole cliff face and across section seams.
  // Strong warp first: unwarped bedding reads as corduroy because every band
  // is a perfectly straight line of identical thickness.
  const bedHardness = float(0.5).toVar('bedHardness')
  const bedProfile = float(0.5).toVar('bedProfile')
  const bedExposure = float(0).toVar('bedExposure')
  const bedStep = float(0).toVar('bedStep')
  const strata = float(0.5).toVar('strata')
  const crossBedding = float(0.5).toVar('crossBedding')
  const blocks = float(0.25).toVar('blocks')
  const buttress = float(0.5).toVar('buttress')
  const arid = aridBlend(slow).toVar('arid')

  // None of the following fields can affect a pixel with zero rock and scree
  // coverage. Keeping them behind one coherent material branch avoids paying
  // for an entire cliff shader on meadow and snow pixels.
  If(rockyCoverage.greaterThan(0), () => {
    // Convex ground erodes fastest and outcrops hardest; the concave ground
    // beside it is where the products of that erosion end up.
    outcrop.assign(slow.curvature.mul(0.5).add(0.5))

    const bedded = slow.bedded

  // Bedding is a stack of *dipping planes* cutting through the rock mass, not a
  // set of height contours painted on the surface — and it is the very same
  // stack the mesh was terraced along, so the shaded band and the geometric
  // ledge are one bed rather than two patterns that happen to overlap.
    const beddingNormal = slow.beddingNormal.toVar('beddingNormal')
    const bedThickness = slow.bedThickness.toVar('bedThickness')
    const bandDepth = bedded.dot(beddingNormal).div(bedThickness).toVar('bandDepth')

  // How obliquely this surface cuts the beds. A face square to the bedding
  // shows a tight, sharp stack; a dip slope lying *along* the bedding is a
  // single smooth slab with no banding at all. Without this term every surface
  // in the scene carries the same stripes at the same spacing regardless of
  // which way it points, which is what makes procedural strata read as a
  // pattern wrapped around the mountain rather than as rock that was cut.
    const alignment = dot(normal, beddingNormal).abs().toVar('bedAlignment')
    const cutAngle = smoothstep(0.12, 0.55, alignment.oneMinus()).toVar('cutAngle')
  // Irregular bed thickness: displacing the band coordinate by noise *of the
  // band coordinate* keeps beds continuous while making no two the same size.
  // The displacement has to stay well below one band per band, or successive
  // beds fold through each other and the banding dissolves into mush.
    const bandCoordinate = bandDepth
      .add(fbm1(bandDepth.mul(0.11).add(4.7), 1).sub(0.5).mul(0.7))
      .toVar('bandCoordinate')
    const strataBand = bandCoordinate.fract().toVar('strataBand')
  // Alternating hard and soft beds: hard ones stand proud and hold an edge.
    bedHardness.assign(
      fbm1(bandCoordinate.floor().mul(1.7), 2),
    )
    bedProfile.assign(
      smoothstep(0.0, 0.3, strataBand).mul(
        falloff(1.0, 0.62, strataBand),
      ),
    )
  // The bench profile is what actually produces a shadow line: a short, steep
  // riser at the base of each bed and a near-flat tread above it. A smooth
  // sinusoid across the whole band, which is what a plain profile gives, tilts
  // the normal by a degree or two and disappears.
  // Only part of a massif is bedded rock at the surface; elsewhere it is
  // massive, jointed or covered. Gating by slow noise keeps the benches from
  // ringing the whole mountain like contour lines on a map.
    bedExposure.assign(
      smoothstep(0.22, 0.58, slow.bedExposure)
        .mul(cutAngle)
        // Beds outcrop on rock. On the debris and turf below they are buried,
        // and printing them there is what turns strata into contour lines drawn
        // across the whole hillside.
        .mul(smoothstep(0.25, 0.7, weights.rock)),
    )
    bedStep.assign(
      smoothstep(0.0, 0.16, strataBand)
        .mul(mix(float(0.45), float(1.15), bedHardness))
        .mul(bedExposure),
    )
    strata.assign(
      mix(float(0.55), float(1), bedProfile)
        .mul(mix(float(0.7), float(1), bedHardness))
        // Beds only exist where rock is actually exposed; on turf this term would
        // otherwise print contour lines across the grass.
        .mix(float(0.5), weights.rock.oneMinus().mul(0.85)),
    )

    // --- cross-bedding ----------------------------------------------------
    // Inside a single aeolian bed the laminae are not parallel to the bed at
    // all: they are the preserved slipfaces of the dunes that built it, dipping
    // up to thirty degrees and then sliced off flat at the top of the set where
    // the next dune migrated across. Sets a metre or two thick, each recording
    // a different wind, truncating one another at an angle — that is the
    // texture of a desert sandstone, and it is the reason a Navajo cliff cannot
    // be produced by taking a limestone cliff and making it orange. It is also
    // the one rock texture here that is finer than the bedding rather than
    // coarser, so it carries the face at the ranges where the beds themselves
    // have already merged into a single tone.
    If(arid.greaterThan(0), () => {
      const setPhase = fbm1(bandCoordinate.floor().mul(2.3).add(11.4), 2)
      // The tilt comes from the set's own index, so every lamina within a set
      // agrees and the boundary between two sets is a real angular discordance
      // rather than a phase shift in one continuous pattern.
      const tilt = setPhase.sub(0.5).mul(2.2)
      const laminaNormal = normalize(
        beddingNormal.add(vec3(tilt, 0, tilt.mul(0.6)).mul(0.62)),
      )
      const laminaDepth = bedded
        .dot(laminaNormal)
        .div(bedThickness.mul(0.085))
        .toVar('laminaDepth')
      const lamina = laminaDepth.fract()
      crossBedding.assign(
        // A lamina is a grain-size parting, not a groove: it holds a hairline
        // shadow on one side and fades over the rest of its spacing.
        smoothstep(0.0, 0.22, lamina)
          .mul(falloff(1.0, 0.72, lamina))
          .mul(arid)
          .mul(cutAngle)
          .mul(smoothstep(0.2, 0.65, weights.rock)),
      )
    })

  // --- meso band: rock blocks and boulders --------------------------------
  // Jointing is not uniform: whole stretches of a face are massive and smooth,
  // others are broken into blocks. Modulating the amount by bed hardness and by
  // slow noise is what stops this reading as one repeating texture.
    const jointing = slow.jointing
      .mul(mix(float(0.45), float(1.15), bedHardness))
      .toVar('jointing')
    If(footprint.lessThan(detailDeadFootprint(BLOCK_SIZE)), () => {
      const blockCell = cells(warp(position, float(0.55), float(0.35)).mul(0.55))
      blocks.assign(
        fadeToMean(
          falloff(0.62, 0.12, blockCell.z.sub(blockCell.x)).mul(
            smoothstep(0.35, 0.75, jointing),
          ),
          float(0.25),
          detailFade(footprint, float(BLOCK_SIZE)),
        ),
      )
    })

  // Buttress-scale structure: the 6–20 m ribs and gullies that give a cliff its
  // large-form silhouette shading long before any block detail is resolvable.
    buttress.assign(slow.buttress)
  })

  // --- micro band: cracks, pebbles, clumps --------------------------------
  // Every band below is band-limited and dissolves to its own mean once a pixel
  // is wider than the features in it. Beyond that point evaluating it is pure
  // waste, and on a landscape most of the screen is beyond it — so the whole
  // block is skipped rather than computed and then faded. The branch is on view
  // footprint, which varies smoothly across the screen, so it stays coherent.
  // Matching each fallback to the band's own faded mean is what makes the
  // branch invisible; a fallback of 0.5 against a ridge stack averaging 0.29
  // leaves a step exactly where the branch is taken.
  const crack = float(0.29).toVar('crack')
  const pebble = float(0.35).toVar('pebble')
  const pebbleId = float(0.5).toVar('pebbleId')
  const clump = float(0.5).toVar('clump')
  const blade = float(0.5).toVar('blade')
  const ripple = float(0.5).toVar('ripple')
  const grainflow = float(0.5).toVar('grainflow')
  const slipface = float(0).toVar('slipface')

  If(footprint.lessThan(lodDeadFootprint(CRACK_WAVELENGTH)), () => {
    If(rockyCoverage.greaterThan(0), () => {
      crack.assign(ridgedLod(position, float(CRACK_WAVELENGTH), 4, footprint))
    })
    If(groundCoverage.greaterThan(0), () => {
      // The warp displacement has to stay small next to the wavelength it is
      // perturbing. At an amplitude larger than the feature size the field is
      // not decorrelated but dragged, and the result is the smeared, ropey
      // "taffy" look that reads instantly as a warped noise texture.
      const groundClumpBands = fbmLodBands(
        warp2(position.xz, float(CLUMP_WAVELENGTH * 0.22), float(1.6)),
        float(CLUMP_WAVELENGTH),
        5,
        2,
        footprint,
      )
      clump.assign(groundClumpBands.value)
      If(footprint.lessThan(lodDeadFootprint(BLADE_WAVELENGTH)), () => {
        If(turfCoverage.greaterThan(0), () => {
          blade.assign(groundClumpBands.fine)
        })
      })
    })
    If(weights.rock.greaterThan(0), () => {
      const rockClumpBands = fbmLodBands(
        warp(position, float(CLUMP_WAVELENGTH * 0.22), float(1.6)).mul(vec3(1, 0.45, 1)),
        float(CLUMP_WAVELENGTH),
        5,
        2,
        footprint,
      )
      clump.assign(mix(clump, rockClumpBands.value, weights.rock))
    })

    If(footprint.lessThan(detailDeadFootprint(PEBBLE_SIZE)), () => {
      If(weights.scree.greaterThan(0), () => {
        const pebbleCell = cells2(
          warp2(position.xz, float(0.06), float(2.7)).mul(5.5),
        )
        pebble.assign(
          fadeToMean(
            falloff(0.55, 0.06, pebbleCell.x),
            float(0.35),
            detailFade(footprint, float(PEBBLE_SIZE)),
          ),
        )
        pebbleId.assign(pebbleCell.y)
      })
    })
  })

  // --- aeolian band: ripples and grainflow ---------------------------------
  // Everything here applies to one thing only: sand, in a climate dry enough to
  // keep moving it. Sand under an alpine sky is a river bar, and it has none of
  // this.
  const sandCoverage = weights.soil.mul(arid).toVar('sandCoverage')
  If(sandCoverage.greaterThan(0.02), () => {
    // A slipface is sand standing at its angle of repose, and nothing else in a
    // desert is both that steep and that clean. Thirty-two degrees puts the
    // surface normal at y = 0.85, so the threshold sits either side of a slope
    // of 0.15 and separates the face from the windward ramp — around four
    // degrees — with room to spare.
    slipface.assign(smoothstep(0.075, 0.135, weights.slope))

    If(footprint.lessThan(detailDeadFootprint(GRAINFLOW_WIDTH)), () => {
      // Both bedforms are indexed off the same fixed wind frame. See WIND_AXIS
      // for why this must not be derived from the surface.
      const downwind = dot(position.xz, WIND_AXIS).toVar('downwind')
      const alongCrest = dot(position.xz, CREST_AXIS).toVar('alongCrest')

      // Grainflow tongues: sand released at the brink does not slide as a sheet
      // but in discrete tongues a metre or two wide that run the full height of
      // the face. Stretching the sample coordinate ten to one along the fall
      // line is what makes them tongues rather than blobs — the same field
      // sampled isotropically gives a mottle that reads as dirt on the sand.
      If(slipface.greaterThan(0.01), () => {
        // A tongue is a stripe: constant down the fall line, varying across it.
        // That makes the field genuinely one-dimensional, and taking it from a
        // scalar noise indexed by the across-slope coordinate is both cheaper
        // than a stretched 3D tap and more faithful — an anisotropically scaled
        // 3D noise still decorrelates slowly along the stretched axis, so its
        // tongues wander and break up over a few metres instead of running the
        // full height of the face the way real grainflow does.
        // A slipface faces downwind by construction, so the across-slope
        // direction the tongues are indexed by is the across-wind one.
        const acrossSlope = alongCrest.div(GRAINFLOW_WIDTH)
        // Tongues do not all reach the same distance, so a slow term along the
        // fall line lets some die out part-way down without ever bending one.
        const reach = fbm1(downwind.mul(0.04).add(7.3), 1)
        grainflow.assign(
          fadeToMean(
            mix(float(0.5), fbm1(acrossSlope, 3), reach.mul(0.6).add(0.55).clamp(0, 1)),
            float(0.5),
            detailFade(footprint, float(GRAINFLOW_WIDTH)),
          ),
        )
      })

      If(footprint.lessThan(detailDeadFootprint(RIPPLE_WAVELENGTH)), () => {
        const rippleCoordinate = downwind.div(RIPPLE_WAVELENGTH)
        // Real ripple crests meander and fork rather than running dead
        // straight, and the forks are what stop a large expanse from reading as
        // printed corduroy. Displacing the phase produces both at once: where
        // the displacement gradient exceeds one crest spacing, a crest divides.
        //
        // The displacement varies only *along* the crest, which is what makes
        // it a one-dimensional field and lets a scalar noise stand in for the
        // 3D tap this started as. That is not a saving at the cost of quality:
        // a 3D noise also varies across the crests, which shifts neighbouring
        // crests independently and mushes the parallel banding that is the
        // whole reason ripples read at distance.
        const meander = fbm1(alongCrest.mul(0.42), 2).sub(0.5).mul(1.4)
        const rippleWave = rippleCoordinate.add(meander).fract()
        ripple.assign(
          fadeToMean(
            // Ripples carry the same asymmetry as the dune, for the same
            // reason and at a thousandth the size: a gentle stoss and a short
            // lee, all facing the same way.
            smoothstep(0, 0.66, rippleWave).mul(falloff(1.0, 0.74, rippleWave)),
            float(0.5),
            detailFade(footprint, float(RIPPLE_WAVELENGTH)),
          ),
        )
        // Avalanching wipes the face clean; ripples rebuild only where the sand
        // has come to rest. This is the single clearest read on a dune — the
        // ripple texture stops dead at the brink line.
        ripple.assign(mix(ripple, float(0.5), slipface.mul(0.9)))
      })
    })
  })

  // The ripple's contribution to *relief* has to die long before its
  // contribution to colour does. It is a sawtooth, and a sawtooth's derivative
  // reaches Nyquist several times sooner than its value: at three samples per
  // period the colour band is merely soft, while the gradient driving the
  // shading normal is already pure noise — and a noisy normal on a sunlit sand
  // slope does not read as texture, it reads as black. Fading the relief copy
  // against a feature size a third of the true one buys that margin, and costs
  // only the last few metres of visible ripple bump.
  const rippleRelief = fadeToMean(
    ripple,
    float(0.5),
    detailFade(footprint, float(RIPPLE_WAVELENGTH * 0.34)),
  ).toVar('rippleRelief')

  // --- assemble relief ----------------------------------------------------
  // Amplitudes are in metres and roughly proportional to each band's
  // wavelength. This is the detail that was missing before: a 9 m rib carrying
  // 5 cm of relief produces a one-degree normal tilt and is invisible, while
  // the same rib at 1 m reads as real structure from a kilometre away.
  // Hard beds stand proud of soft ones. This differential relief, not the band
  // colour, is what produces the shadow line along every bedding plane.
  const bedProud = mix(float(-0.45), float(0.55), bedHardness)
    .mul(bedExposure)
    .toVar('bedProud')
  const rockRelief = bedStep
    .mul(0.42)
    .add(bedProud)
    .add(strata.mul(0.18))
    .add(buttress.mul(1.15))
    .add(outcrop.mul(0.42))
    .add(blocks.mul(0.24))
    .add(crack.mul(0.085))
    // Laminae stand out by a few centimetres at most — differential cementation
    // across a grain-size parting, not a ledge. Any more and a cliff face reads
    // as corrugated iron.
    .add(crossBedding.mul(0.055))
    .toVar('rockRelief')

  const screeRelief = pebble
    .mul(0.035)
    .add(blocks.mul(0.18))
    .add(macro.mul(0.45))
    .toVar('screeRelief')

  // Near-field turf: blade clumps at a few centimetres, and the loose stones
  // that are always scattered through alpine pasture. Both are band-limited, so
  // they cost nothing once they are further away than they can be resolved.
  const looseStone = float(0.04).toVar('looseStone')
  // 0.7 m is where `looseStone`'s own fade has fully dissolved it; branching
  // any earlier cuts the band while it is still contributing, and the cut edge
  // is visible as a dashed line across the slope.
  If(footprint.lessThan(detailDeadFootprint(LOOSE_STONE_SIZE)), () => {
    If(turfCoverage.greaterThan(0), () => {
      // Sparse: only the cells whose centre falls very close to the sample make a
      // stone, so most of the turf stays clear instead of being cobbled over.
      const looseCell = cells2(
        warp2(position.xz, float(0.05), float(2.4)).mul(1.5),
      )
      // One stone per cell cobbles the whole sward. Real pasture has a stone
      // every metre or two, so most cells are given none at all — selected by
      // the cell's own identity, which keeps the choice stable and free.
      const stonePresent = smoothstep(0.52, 0.66, looseCell.y)
      looseStone.assign(
        fadeToMean(
          falloff(0.26, 0.05, looseCell.x).mul(stonePresent),
          float(0.04),
          detailFade(footprint, float(LOOSE_STONE_SIZE)),
        ),
      )
      If(weights.scree.equal(0), () => {
        pebbleId.assign(looseCell.y)
      })
    })
  })
  const turfRelief = blade
    .mul(0.022)
    .add(clump.mul(0.09))
    .add(looseStone.mul(0.075))
    .add(macro.mul(0.55))
    .toVar('turfRelief')

  // Sand relief is tiny in absolute terms and that is the point. A ripple is
  // about a centimetre and a half from trough to crest; a grainflow tongue
  // stands a few centimetres proud of the face beside it. Sand's whole visual
  // character comes from being *smooth at every scale but one*, so the macro
  // band is also cut right back here — undulating the sand the way turf
  // undulates is what makes procedural deserts look like carpet.
  const sandRelief = rippleRelief
    .mul(0.016)
    .add(grainflow.mul(0.055).mul(slipface))
    .add(macro.mul(0.18))
    .toVar('sandRelief')
  const snowRelief = macro.mul(0.4).toVar('snowRelief')

  // Layer competition uses only the micro band. Mixing metre-scale structure
  // into the contest would let a rock rib win coverage from grass half a metre
  // away, which is a coverage decision, not a surface-height one.
  // What the contest needs from each layer is *how far its surface departs from
  // the mean at this point*, not how much relief the material has in general.
  // Feeding in the absolute amplitudes makes rock stand a quarter of a metre
  // above soil everywhere, so rock wins every pixel it has any coverage on and
  // no boundary ever interlocks. Each term is therefore centred on zero, and
  // the small constants are the one genuinely asymmetric part: a rock ledge
  // does stand slightly proud of the debris against it, and snow lies on top of
  // whatever it falls on.
  const microHeights = {
    grass: clump.sub(0.5).mul(0.1),
    meadow: clump.mul(0.7).add(macro.mul(0.3)).sub(0.5).mul(0.08),
    // In an arid climate this slot is sand, which lies flatter than any soil
    // and buries what it laps against rather than interlocking with it.
    soil: mix(
      macro.sub(0.5).mul(0.05).sub(0.01),
      rippleRelief.sub(0.5).mul(0.02).add(0.01),
      arid,
    ),
    scree: pebble.sub(0.35).add(blocks.sub(0.25).mul(0.4)).mul(0.14).add(0.015),
    rock: crack.add(strata).sub(1).mul(0.12).add(crossBedding.sub(0.5).mul(0.03)).add(0.04),
    // Snow drifts fill hollows: smooth, and it buries what is beneath.
    snow: macro.sub(0.5).mul(0.06).add(0.07),
  }

  const resolved = resolveByHeight(weights, microHeights)

  const reliefByLayer = {
    grass: turfRelief,
    meadow: turfRelief,
    soil: mix(turfRelief, sandRelief, arid),
    scree: screeRelief,
    rock: rockRelief,
    snow: snowRelief,
  }
  const height = float(0).toVar('reliefHeight')
  for (const key of Object.keys(reliefByLayer)) {
    height.addAssign(
      resolved[key].mul(reliefByLayer[key as keyof typeof reliefByLayer]),
    )
  }

  // Reuse the exact fields already evaluated above for the normal gradient.
  // Keeping coverage out of the height-based layer resolver avoids a hard
  // gradient where two layers trade first place, while still preserving every
  // visible scale: broad turf undulation, clumps, blades, loose stones,
  // bedding, buttresses and hairline cracks.
  const rocky = weights.rock.add(weights.scree.mul(0.7)).clamp(0, 1)
  const normalRockHeight = bedStep
    .mul(0.5)
    .add(buttress.mul(1.1))
    .add(crack.mul(0.09))
    .add(crossBedding.mul(0.05))
  const normalTurfHeight = macro
    .mul(0.5)
    .add(clump.mul(0.09))
    .add(blade.mul(0.0108))
    .add(looseStone.mul(0.036))
  const normalSandHeight = macro
    .mul(0.18)
    .add(rippleRelief.mul(0.016))
    .add(grainflow.mul(0.05).mul(slipface))
  // Sand is resolved before rock: an erg has no rock in it to speak of, and
  // where a dune laps onto an outcrop the rock is what stands proud.
  const sandy = weights.soil.mul(arid).clamp(0, 1)
  const normalHeight = mix(
    mix(normalTurfHeight, normalSandHeight, sandy),
    normalRockHeight,
    rocky,
  )

  return {
    height,
    normalHeight,
    resolved,
    detail: {
      strata,
      crossBedding,
      arid,
      ripple,
      grainflow,
      slipface,
      bedHardness,
      bedProfile,
      bedStep,
      bedExposure,
      bedProud,
      crack,
      blocks,
      buttress,
      pebble,
      pebbleId,
      clump,
      blade,
      looseStone,
      macro,
      outcrop,
    },
  }
}

/**
 * Height-aware weight resolve. Each layer competes with `coverage + relief`;
 * only the layers within `HEIGHT_BLEND_DEPTH` of the winner survive, which
 * produces a narrow, interlocking transition instead of a muddy average.
 *
 * The two terms have to stay commensurate. Biasing coverage hard enough to
 * exclude absent layers — the obvious way to keep grass off a cliff — turns the
 * contest into an argmax on coverage: relief never gets a vote and every
 * boundary in the scene collapses to whichever single layer leads, however
 * slightly. Absent layers are excluded instead by the final multiply by
 * coverage, which cannot distort the contest because it happens after it.
 */
function resolveByHeight(
  weights: LayerWeights,
  heights: Record<string, any>,
): Record<string, any> {
  const keys = Object.keys(heights)
  const scores: Record<string, any> = {}
  const peak = float(-1000).toVar('peak')
  for (const key of keys) {
    const coverage = (weights as Record<string, any>)[key]
    const score = coverage.mul(COVERAGE_BIAS).add(heights[key]).toVar()
    scores[key] = score
    // A layer that is not here at all must not set the bar the others are
    // measured against — snow lying proud of everything would otherwise
    // suppress the whole stack on a bare summer hillside. Excluding it from the
    // peak does that without touching the contest between the layers that are
    // present.
    peak.assign(max(peak, mix(float(-1000), score, smoothstep(0, 0.03, coverage))))
  }

  const cutoff = peak.sub(HEIGHT_BLEND_DEPTH)
  const resolved: Record<string, any> = {}
  const total = float(0.00001).toVar('weightTotal')
  for (const key of keys) {
    const value = max(scores[key].sub(cutoff), 0).mul((weights as Record<string, any>)[key]).toVar()
    resolved[key] = value
    total.addAssign(value)
  }
  for (const key of keys) resolved[key] = resolved[key].div(total)
  return resolved
}

/**
 * Albedo, roughness and cavity occlusion for the resolved surface.
 *
 * Colour varies at every scale that relief does: per bedding plane, per rock
 * block, per pebble and across tens of metres. Uniform albedo inside a material
 * region is the most obvious tell of a procedural surface.
 */
export function shadeSurface(
  weights: LayerWeights,
  surface: SurfaceDetail,
  slow: TerrainSlowFields,
): { albedo: any; roughness: any; cavity: any } {
  const { detail, resolved } = surface
  // Recomputed nowhere: the relief pass already resolved the climate blend, and
  // shading has to cross over at exactly the same place it did.
  const arid = detail.arid

  // --- rock --------------------------------------------------------------
  // Reflectances are the measured dry-rock range: fresh granite and pale
  // limestone sit near 0.30-0.40, and the weathering, bedding, block and crack
  // terms below only ever subtract from that. Stacking five such multipliers on
  // a 0.17 base drove finished rock to about 0.03 — darker than fresh asphalt —
  // which is why the massif read as a silhouette under any amount of sky.
  // One lithology per region, varying slowly, rather than a different rock type
  // in every bed. A sequence of beds is deposited in one basin from one source,
  // so successive beds differ in grain, cement and weathering — a matter of ten
  // or twenty per cent in value — not in kind. Swinging between a near-black
  // shale and a white dolomite bed by bed is what turns strata into humbug
  // stripes, and it is the single loudest tell of a procedural cliff.
  const bedType = detail.bedHardness
  const carbonate = vec3(0.412, 0.394, 0.348)
  const silicate = vec3(0.298, 0.290, 0.292)

  // The alpine sequence below keeps its bed-to-bed colour spread deliberately
  // tiny, because a limestone or granite sequence really does differ only in
  // grain and cement. A red-bed sandstone is the one lithology where that rule
  // inverts: what changes between beds is the oxidation state of the iron in
  // the cement, and that swings the rock from hematite red through buff to
  // near-white across a few metres of section. Stripes legible from thirty
  // kilometres are the correct answer here — they are what the Colorado Plateau
  // actually looks like. One formation is one basin with one iron budget, so
  // the *range* a sequence swings over stays regional even though the beds
  // inside it alternate fast.
  const ironBudget = smoothstep(0.25, 0.78, slow.regionalTint)
  const sandstoneBed = mix(
    mix(vec3(0.268, 0.132, 0.074), vec3(0.392, 0.330, 0.223), smoothstep(0.18, 0.86, bedType)),
    mix(vec3(0.300, 0.148, 0.083), vec3(0.368, 0.310, 0.210), smoothstep(0.3, 0.7, bedType)),
    ironBudget,
  )

  // One lithology, crossed over between the climates *before* any of the shared
  // weathering is applied to it.
  //
  // The obvious structure — shade an alpine rock, shade a sandstone, and mix
  // the two results — is what this replaces, and the reason is register
  // pressure rather than tidiness. Both palettes are live simultaneously from
  // the moment the first is computed until the final blend, which on a shader
  // that already carries forty-two noise evaluations is enough extra live vec3
  // state to halve occupancy. Blending the *inputs* costs one lerp, keeps a
  // single set of colours alive, and produces the same picture, because every
  // modifier downstream — bedding, jointing, weathering, cavity — applies to
  // both rocks in exactly the same way.
  const lithology = mix(
    mix(silicate, carbonate, smoothstep(0.3, 0.66, slow.regionalTint)),
    sandstoneBed,
    arid,
  ).toVar('lithology')

  // Resistant beds weather pale and clean; weak beds hold more clay, weather
  // recessively and stay darker and browner in the shelter of the bed above.
  // The spread is deliberately small. Bedding is read by the eye from the
  // *shadow line* along each parting and from the ledge profile, not from a
  // change of colour, and any appreciable colour step turns the sequence into
  // painted stripes that stay legible from kilometres away — which real beds,
  // seen through that much air, do not.
  // Damped in arid ground: `sandstoneBed` already carries a far larger
  // bed-to-bed swing of its own, and stacking this one on top of it drives the
  // pale beds to white.
  const bedValue = mix(float(0.88), float(1.07), bedType).mix(float(1), arid.mul(0.7))
  const bedWarmth = mix(vec3(1.03, 0.99, 0.94), vec3(0.99, 1.0, 1.01), bedType)
  const bedTint = lithology.mul(bedValue).mul(bedWarmth)

  // The parting between two beds is a recessed joint that collects shadow and
  // dirt; it is the line the eye actually reads as bedding.
  const parting = falloff(0.35, 0.0, detail.bedProfile)
    .mul(detail.bedExposure)
    .mul(0.26)
  const mottle = slow.mottle
  // Limonite staining bleeds downwards from iron-bearing beds and concentrates
  // where water has run over the face, so it is keyed to flow, not to noise.
  // In arid ground the same multiplier slot carries the cross-bedding instead:
  // the coarse foreset laminae are cemented differently from the fine ones
  // between them, so they read as a value change as much as a relief one.
  const ironStain = mix(
    mix(
      vec3(1, 1, 1),
      vec3(1.22, 0.82, 0.52),
      smoothstep(0.45, 0.9, mottle.mul(0.5).add(slow.flow.mul(0.5))).mul(0.7),
    ),
    vec3(mix(float(0.86), float(1.1), detail.crossBedding)),
    arid,
  )
  const blockShade = mix(float(0.86), float(1.08), detail.blocks)
  const buttressShade = mix(float(0.84), float(1.06), detail.buttress)

  // The variation that actually survives a kilometre of air is none of the
  // above — every one of those bands is finer than a pixel by then, and their
  // average is a single flat tone. What remains legible at that range is the
  // landform's own weathering pattern: ribs and noses stand in the sun and the
  // wind, lose their lichen and their damp, and bleach; the gullies between
  // them stay shaded, damp and dark. Keying rock value to curvature is what
  // gives a distant face light and shade that belong to its shape rather than
  // to the sun angle alone.
  const weathering = mix(
    vec3(0.85, 0.86, 0.89),
    vec3(1.14, 1.12, 1.08),
    smoothstep(-0.55, 0.5, slow.curvature),
  )
  const rockBase = bedTint
    .mul(ironStain)
    .mul(blockShade)
    .mul(buttressShade)
    .mul(weathering)
    .mul(parting.oneMinus())
  const crackDarken = falloff(0.55, 0.12, detail.crack).mul(0.34)
  const rockCracked = rockBase.mul(crackDarken.oneMinus().max(0.56))
  const lichenColour = mix(
    vec3(0.124, 0.148, 0.082),
    vec3(0.216, 0.222, 0.152),
    detail.clump,
  )
  // Crustose lichen needs recurring humidity to grow at all. Its absence is one
  // of the quieter reasons a desert cliff reads as a desert cliff: nothing has
  // softened or greened the rock, so the bare lithology carries the whole face.
  const lichenMask = weights.lichen
    .mul(arid.oneMinus())
    .mul(smoothstep(0.4, 0.85, mottle))
    .mul(smoothstep(0.35, 0.8, detail.crack))
    .mul(falloff(0.85, 0.25, weights.slope))
    .mul(smoothstep(0.35, 0.7, detail.macro))
  // Desert varnish: a micron-thick manganese and iron oxide film that takes
  // millennia of bacterial accumulation to build, so it survives only where a
  // face is stable and dry. That makes it the exact inverse of the wetness term
  // further down — varnish blackens the panels *between* the water tracks, and
  // the runoff lines stay pale because they are the one place it gets stripped.
  // Streaked canyon walls are almost entirely this.
  //
  // It shares the rock albedo with the lichen rather than forking it: the two
  // masks are mutually exclusive by construction (one is gated on `arid`, the
  // other on its complement) so applying both in sequence costs one extra lerp
  // and never needs a second copy of the rock to blend against.
  // `mottle` is an untyped baked channel, so the chain below infers a vector
  // type it never has at runtime; the annotation keeps it a scalar mask.
  const varnish: any = smoothstep(0.3, 0.8, mottle)
    .mul(smoothstep(0.28, 0.68, weights.slope))
    .mul(falloff(0.55, 0.12, slow.flow))
    .mul(arid)
    .toVar('varnish')
  const rockAlbedo = mix(
    mix(rockCracked, lichenColour, lichenMask.mul(0.7)),
    vec3(0.042, 0.034, 0.03),
    varnish.mul(0.78),
  ).toVar('rockAlbedo')

  // --- scree -------------------------------------------------------------
  // Talus is the same rock, freshly broken. It is lighter than the face it fell
  // from because the fracture surfaces are unweathered, and it is desaturated
  // by the rock flour between the clasts.
  //
  // Desert pavement is the same expression read in an arid climate, and it only
  // needs two of its terms moved. Pavement is a single armoured layer of clasts
  // varnished nearly black on their exposed faces, set in a matrix of pale
  // wind-winnowed fines — so the clasts go darker, the matrix goes lighter, and
  // the contrast between them widens. Averaging the two into one mid-brown,
  // which is what a plain gravel tint gives, loses the whole effect.
  const freshRock = mix(lithology, vec3(0.6), float(0.12)).mul(1.05)
  const clastValue = mix(float(0.72), float(1.18), detail.pebbleId).mix(
    mix(float(0.28), float(0.62), detail.pebbleId),
    arid,
  )
  const matrixValue = float(0.62).mix(float(1.34), arid)
  const screeAlbedo = mix(
    freshRock.mul(matrixValue),
    freshRock.mul(clastValue),
    smoothstep(0.15, 0.7, detail.pebble).mix(smoothstep(0.18, 0.66, detail.pebble), arid),
  ).mul(mix(float(0.86), float(1.1), detail.macro))

  // --- ground cover ------------------------------------------------------
  // Sward is not one colour with a brightness ramp over it. At walking distance
  // it resolves into three things at once: the living crown of each tussock,
  // the bleached dead litter packed between the crowns, and the bare earth
  // showing through wherever the mat is thin. Ramping a single hue by a noise
  // field can reproduce none of that, and a flat expanse of one saturated
  // colour is what a hillside looks like only in a texture atlas.
  //
  // A desert floor has exactly the same three components and differs only in
  // what each one is made of: the bare fraction is sand rather than humus, the
  // litter is bleached almost white, and the living fraction is the grey-green
  // of woody scrub instead of turf. So the climate is folded into the three
  // colours and the structure above them is shared, which is both far cheaper
  // than shading two grounds and blending them, and a better description — the
  // reason a desert reads as sparse is that the *coverage* is low, not that a
  // different kind of surface is being drawn.
  const tussock = smoothstep(0.34, 0.74, detail.clump).toVar('tussock')
  const thinning = falloff(0.42, 0.08, detail.clump).toVar('swardThinning')
  const bladeShade = mix(float(0.86), float(1.1), detail.blade)

  // Sand is the same rock as the cliff with its iron coatings abraded off by
  // transport, so it is far paler and less saturated while staying
  // unmistakably related to it.
  const sandBase = mix(
    vec3(0.318, 0.252, 0.158),
    vec3(0.408, 0.345, 0.238),
    detail.macro,
  ).mul(mix(float(0.95), float(1.06), ironBudget.oneMinus())).toVar('sandBase')

  // Measured diffuse reflectance, not a mood. Alpine turf sits near 0.13,
  // bleached litter near 0.25 and humic soil near 0.12; the values below used
  // to be a third of that, which is asphalt, and no amount of sky fill can
  // rescue a surface that absorbs 96% of what reaches it. The frame read as
  // unlit rather than as evening because of this, not because of the sun.
  const bareEarth = mix(
    mix(vec3(0.118, 0.092, 0.066), vec3(0.176, 0.142, 0.104), detail.macro),
    sandBase,
    arid,
  )
  const litter = mix(
    mix(vec3(0.152, 0.136, 0.088), vec3(0.208, 0.186, 0.122), detail.macro),
    sandBase.mul(0.88),
    arid,
  )
  const liveTurf = mix(
    mix(vec3(0.082, 0.126, 0.052), vec3(0.128, 0.176, 0.076), detail.macro),
    mix(vec3(0.082, 0.078, 0.038), vec3(0.152, 0.142, 0.078), detail.macro),
    arid,
  )

  // Stones sit in the sward, so they carry its shadow at their base and are
  // never brighter than the rock they broke from.
  const stoneColour = freshRock
    .mul(0.48)
    .mul(mix(float(0.72), float(1.15), detail.pebbleId))
  const stoneMask = smoothstep(0.3, 0.62, detail.looseStone)

  // Lush ground: turf in the mountains, and the one genuinely green line in a
  // desert, where a wash keeps a root zone wet long after the surface has
  // dried. It earns its saturation precisely because nothing around it has any.
  const grassAlbedo = mix(
    mix(
      mix(litter, liveTurf, tussock).mul(bladeShade),
      bareEarth,
      thinning.mul(0.55),
    ),
    stoneColour,
    stoneMask,
  )
  // Dry ground: the same structure with the living fraction bleached out. The
  // contrast between this and green turf along a drainage line is the strongest
  // vegetation cue a mountainside has, and in a desert it is the only one.
  const meadowAlbedo = mix(
    mix(
      mix(litter.mul(1.04), mix(litter, liveTurf, float(0.3)), tussock).mul(bladeShade),
      bareEarth.mul(1.1),
      thinning.mul(0.6),
    ),
    stoneColour.mul(1.06),
    stoneMask,
  )

  // Bare ground: soil in the mountains, open sand in the desert. Only this slot
  // takes the aeolian treatment, because only this slot is ever sand.
  //
  // Ripples sort the sand as they build: the coarse, dark, heavy grains are
  // driven up and left on the crests while the fine pale ones collect in the
  // troughs, so the colour banding is *inverted* relative to the shading — the
  // crests are the darker stripe even though they catch the light. Getting that
  // backwards, by tinting with height the way a naive detail texture would,
  // cancels the effect and leaves the ripples reading as pure bump.
  const aeolian = mix(
    float(1).mix(mix(float(1.06), float(0.9), detail.ripple), arid),
    // A slipface is freshly avalanched: better sorted, more uniform, and a
    // touch darker than the rippled ramp because the loose surface layer packs
    // open and traps light between the grains.
    mix(float(0.9), float(0.99), detail.grainflow).mul(arid).add(arid.oneMinus()),
    detail.slipface,
  )
  const soilAlbedo = mix(
    bareEarth,
    mix(bareEarth, litter, float(0.45)),
    detail.macro,
  ).mul(aeolian)

  // --- snow --------------------------------------------------------------
  const snowAlbedo = vec3(0.62, 0.65, 0.7)
    .mul(mix(float(0.9), float(1.03), detail.macro))
    .mul(mix(float(0.94), float(1.02), detail.clump))

  // One material per role, already carrying its climate. The cross-over happened
  // upstream in the inputs to each of these, not here on their outputs, so the
  // margin costs a handful of lerps rather than a second copy of the entire
  // shading pass. Coverage is untouched by climate either way: the margin
  // changes what a layer is made of, never which layer is where.
  const albedo = vec3(0).toVar('albedo')
  albedo.addAssign(grassAlbedo.mul(resolved.grass))
  albedo.addAssign(meadowAlbedo.mul(resolved.meadow))
  albedo.addAssign(soilAlbedo.mul(resolved.soil))
  albedo.addAssign(screeAlbedo.mul(resolved.scree))
  albedo.addAssign(rockAlbedo.mul(resolved.rock))
  albedo.addAssign(snowAlbedo.mul(resolved.snow))

  // Slow, large-scale value variation over everything: nothing in nature holds
  // one reflectance across a whole hillside.
  albedo.mulAssign(mix(float(0.86), float(1.08), slow.regionalTint))

  // Wet rock. A film of water fills the surface pores, so light that would have
  // scattered back out is instead refracted into the substrate and absorbed:
  // the albedo drops by roughly half and the reflection sharpens to near
  // specular. This is why the runnels down a cliff are dark streaks and why the
  // rock beside a stream looks like a different material. It costs one lerp and
  // it is worth more than any amount of added noise, because it puts a visible
  // consequence on the drainage network the terrain was carved with.
  const wetness: any = float(smoothstep(0.35, 0.9, float(slow.flow)))
    .mul(smoothstep(0.1, 0.45, weights.moisture).mul(0.6).add(0.4))
    // A desert drainage is dry almost every day of its life. It keeps a trace
    // of the effect because the shaded pools under a pour-off genuinely do
    // persist, but a canyon whose every water track glistens is a rainforest.
    .mul(mix(float(1), float(0.3), arid))
    .mul(resolved.rock.add(resolved.scree).add(resolved.soil).clamp(0, 1))
    .mul(falloff(0.72, 0.2, weights.slope).mul(0.5).add(0.5))
    .clamp(0, 1)
    .toVar('wetness')
  albedo.mulAssign(mix(vec3(1), vec3(0.48, 0.5, 0.54), wetness))

  const roughness = float(0).toVar('roughness')
  /** A role's roughness, crossed over between the two climates' tables. */
  const layerRoughness = (key: keyof typeof SURFACE_LAYERS): any =>
    mix(
      float(SURFACE_LAYERS[key].roughness),
      float(ARID_SURFACE_LAYERS[key].roughness),
      arid,
    )
  roughness.addAssign(layerRoughness('grass').mul(resolved.grass))
  roughness.addAssign(layerRoughness('meadow').mul(resolved.meadow))
  roughness.addAssign(layerRoughness('soil').mul(resolved.soil))
  // Broken talus scatters light very differently from the polished face above
  // it, which is most of what makes a fan legible at distance.
  roughness.addAssign(layerRoughness('scree').add(0.1).mul(resolved.scree))
  roughness.addAssign(layerRoughness('rock').mul(resolved.rock))
  roughness.addAssign(layerRoughness('snow').mul(resolved.snow))
  // Damp rock in the shaded crack bottoms reads as wet stone, and hard beds
  // weather smoother than the soft ones between them.
  // Weathered rock is matte. Damp crack bottoms and hard, close-grained beds
  // are a little smoother than the rest, but only a little: stacking large
  // subtractions here drives dry stone into a plastic sheen.
  roughness.subAssign(resolved.rock.mul(falloff(0.5, 0.12, detail.crack)).mul(0.08))
  roughness.subAssign(
    resolved.rock.mul(smoothstep(0.45, 0.95, detail.bedHardness)).mul(0.1),
  )
  // The other half of wetness: a water film is optically smooth, so wet rock
  // carries a broad sheen that dry rock never does.
  roughness.assign(mix(roughness, float(0.28), wetness.mul(0.75)))
  // Loose, well-sorted, freshly avalanched sand is measurably smoother than the
  // rippled and crusted ramp above it, which is why a slipface picks up a sheen
  // in raking light that the rest of the dune does not.
  roughness.subAssign(resolved.soil.mul(arid).mul(detail.slipface).mul(0.08))

  // Cavity occlusion from the relief itself: anything sitting below the local
  // mean height is darkened, which is what sells crack and joint depth.
  const rockCavity = detail.crack.mul(0.4).add(detail.blocks.mul(0.3)).add(detail.strata.mul(0.2))
  // Grass self-occludes between clumps, and stones sit in their own shadow.
  const turfCavity = detail.clump
    .mul(0.34)
    .add(detail.blade.mul(0.2))
    .add(falloff(0.6, 0.3, detail.looseStone).mul(0.06))
    .add(0.16)
  // Sand occludes almost nothing: it is a smooth surface with a centimetre of
  // ripple on it, and the ripple troughs are open enough to see most of the
  // sky. A desert reads bright and open largely because of what is *not* here.
  const sandCavity = mix(float(0.86), float(1), detail.ripple).sub(
    detail.slipface.mul(0.04),
  )
  const groundCavity = mix(
    turfCavity,
    sandCavity,
    resolved.soil.mul(arid).clamp(0, 1),
  )
  const cavity = clamp(
    mix(groundCavity, rockCavity, resolved.rock.add(resolved.scree).clamp(0, 1)).add(0.3),
    0.28,
    1,
  )

  return { albedo: albedo.max(vec3(0.008)), roughness: clamp(roughness, 0.05, 1), cavity }
}

/**
 * World-space normal perturbation from the relief gradient.
 *
 * The complete height field has already been evaluated for layer resolution,
 * so differentiating that value gives a more faithful normal at no additional
 * procedural sampling cost. The derivative form (Mikkelsen's surface gradient
 * for unparametrised meshes) gets the gradient from neighbouring pixels in the
 * quad and preserves every macro, meso and micro band in the resolved surface.
 */
export function reliefNormal(
  position: any,
  normal: any,
  height: any,
  strength: any,
): any {
  const positionX = vec3(dFdx(position)).toVar('reliefPositionDx')
  const positionY = vec3(dFdy(position)).toVar('reliefPositionDy')
  const perpendicularX = cross(positionY, normal)
  const perpendicularY = cross(normal, positionX)

  const determinant = float(dot(positionX, perpendicularX)).toVar('reliefDeterminant')
  const surfaceGradient = vec3(
    vec3(perpendicularX)
      .mul(float(dFdx(height)))
      .add(vec3(perpendicularY).mul(float(dFdy(height))))
      .mul(determinant.sign()),
  ).toVar('surfaceGradient')

  // Scaled by |det| so the perturbation is independent of how large the pixel's
  // world footprint is; without it the bump strength would change with distance.
  const shaded = vec3(
    normalize(vec3(normal).mul(determinant.abs()).sub(surfaceGradient.mul(strength))),
  ).toVar('reliefNormal')

  return shaded
}
