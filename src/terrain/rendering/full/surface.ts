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
  macro: any
  /** Signed mean curvature: +1 convex rib, -1 concave hollow. */
  curvature: any
  bedded: any
  buttress: any
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
  const material = varying(
    materialAttribute,
    'terrainSlowMaterial',
  )
  const bakedMoistureLichen = varying(
    vec4(moistureLichen.low, moistureLichen.high, 0, 0),
    'terrainBakedMoistureLichen',
  )
  const warpedAndTint = varying(
    vec4(attribute('terrainSurface3', 'vec4') as any),
    'terrainSlowWarp',
  )
  const relief = varying(
    vec4(attribute('terrainSurface4', 'vec4') as any),
    'terrainSlowRelief',
  )
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
    mottle: material.w,
    bedded: position.add(warpedAndTint.xyz.mul(2).sub(1).mul(16)),
    regionalTint: warpedAndTint.w,
    buttress: relief.x,
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
  const blocks = float(0.25).toVar('blocks')
  const buttress = float(0.5).toVar('buttress')

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
    soil: macro.sub(0.5).mul(0.05).sub(0.01),
    scree: pebble.sub(0.35).add(blocks.sub(0.25).mul(0.4)).mul(0.14).add(0.015),
    rock: crack.add(strata).sub(1).mul(0.12).add(0.04),
    // Snow drifts fill hollows: smooth, and it buries what is beneath.
    snow: macro.sub(0.5).mul(0.06).add(0.07),
  }

  const resolved = resolveByHeight(weights, microHeights)

  const reliefByLayer = {
    grass: turfRelief,
    meadow: turfRelief,
    soil: turfRelief,
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
  const normalTurfHeight = macro
    .mul(0.5)
    .add(clump.mul(0.09))
    .add(blade.mul(0.0108))
    .add(looseStone.mul(0.036))
  const normalHeight = mix(normalTurfHeight, normalRockHeight, rocky)

  return {
    height,
    normalHeight,
    resolved,
    detail: {
      strata,
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

  // --- rock --------------------------------------------------------------
  // One lithology per region, varying slowly, rather than a different rock type
  // in every bed. A sequence of beds is deposited in one basin from one source,
  // so successive beds differ in grain, cement and weathering — a matter of ten
  // or twenty per cent in value — not in kind. Swinging between a near-black
  // shale and a white dolomite bed by bed is what turns strata into humbug
  // stripes, and it is the single loudest tell of a procedural cliff.
  const bedType = detail.bedHardness
  const carbonate = vec3(0.345, 0.330, 0.292)
  const silicate = vec3(0.168, 0.163, 0.166)
  const lithology = mix(
    silicate,
    carbonate,
    smoothstep(0.3, 0.66, slow.regionalTint),
  ).toVar('lithology')

  // Resistant beds weather pale and clean; weak beds hold more clay, weather
  // recessively and stay darker and browner in the shelter of the bed above.
  // The spread is deliberately small. Bedding is read by the eye from the
  // *shadow line* along each parting and from the ledge profile, not from a
  // change of colour, and any appreciable colour step turns the sequence into
  // painted stripes that stay legible from kilometres away — which real beds,
  // seen through that much air, do not.
  const bedValue = mix(float(0.88), float(1.07), bedType)
  const bedWarmth = mix(vec3(1.03, 0.99, 0.94), vec3(0.99, 1.0, 1.01), bedType)
  const bedTint = lithology.mul(bedValue).mul(bedWarmth)

  // The parting between two beds is a recessed joint that collects shadow and
  // dirt; it is the line the eye actually reads as bedding.
  const parting = falloff(0.35, 0.0, detail.bedProfile)
    .mul(detail.bedExposure)
    .mul(0.42)
  const mottle = slow.mottle
  // Limonite staining bleeds downwards from iron-bearing beds and concentrates
  // where water has run over the face, so it is keyed to flow, not to noise.
  const ironStain = mix(
    vec3(1, 1, 1),
    vec3(1.22, 0.82, 0.52),
    smoothstep(0.45, 0.9, mottle.mul(0.5).add(slow.flow.mul(0.5))).mul(0.7),
  )
  const blockShade = mix(float(0.78), float(1.08), detail.blocks)
  const buttressShade = mix(float(0.74), float(1.06), detail.buttress)

  // The variation that actually survives a kilometre of air is none of the
  // above — every one of those bands is finer than a pixel by then, and their
  // average is a single flat tone. What remains legible at that range is the
  // landform's own weathering pattern: ribs and noses stand in the sun and the
  // wind, lose their lichen and their damp, and bleach; the gullies between
  // them stay shaded, damp and dark. Keying rock value to curvature is what
  // gives a distant face light and shade that belong to its shape rather than
  // to the sun angle alone.
  const weathering = mix(
    vec3(0.74, 0.75, 0.79),
    vec3(1.16, 1.14, 1.1),
    smoothstep(-0.55, 0.5, slow.curvature),
  )
  const rockBase = bedTint
    .mul(ironStain)
    .mul(blockShade)
    .mul(buttressShade)
    .mul(weathering)
    .mul(parting.oneMinus())
  const crackDarken = falloff(0.55, 0.12, detail.crack).mul(0.5)
  const rockCracked = rockBase.mul(crackDarken.oneMinus().max(0.4))
  const lichenColour = mix(
    vec3(0.068, 0.086, 0.042),
    vec3(0.152, 0.156, 0.104),
    detail.clump,
  )
  const lichenMask = weights.lichen
    .mul(smoothstep(0.4, 0.85, mottle))
    .mul(smoothstep(0.35, 0.8, detail.crack))
    .mul(falloff(0.85, 0.25, weights.slope))
    .mul(smoothstep(0.35, 0.7, detail.macro))
  const rockAlbedo = mix(rockCracked, lichenColour, lichenMask.mul(0.7))

  // --- scree -------------------------------------------------------------
  // Talus is the same rock, freshly broken. It is lighter than the face it fell
  // from because the fracture surfaces are unweathered, and it is desaturated
  // by the rock flour between the clasts.
  const freshRock = mix(lithology, vec3(0.6), float(0.12)).mul(1.05)
  const pebbleTint = freshRock.mul(mix(float(0.72), float(1.18), detail.pebbleId))
  const screeAlbedo = mix(
    freshRock.mul(0.62),
    pebbleTint,
    smoothstep(0.15, 0.7, detail.pebble),
  ).mul(mix(float(0.86), float(1.1), detail.macro))

  // --- vegetation --------------------------------------------------------
  // Sward is not one colour with a brightness ramp over it. At walking distance
  // it resolves into three things at once: the living crown of each tussock,
  // the bleached dead litter packed between the crowns, and the bare earth
  // showing through wherever the mat is thin. Ramping a single hue by a noise
  // field can reproduce none of that, and a flat expanse of one saturated
  // colour is what a hillside looks like only in a texture atlas.
  const tussock = smoothstep(0.34, 0.74, detail.clump).toVar('tussock')
  const thinning = falloff(0.42, 0.08, detail.clump).toVar('swardThinning')
  const bladeShade = mix(float(0.86), float(1.1), detail.blade)

  const bareEarth = mix(
    vec3(0.062, 0.048, 0.035),
    vec3(0.098, 0.079, 0.058),
    detail.macro,
  )
  const litter = mix(
    vec3(0.112, 0.099, 0.062),
    vec3(0.156, 0.138, 0.088),
    detail.macro,
  )
  const liveTurf = mix(
    vec3(0.038, 0.062, 0.024),
    vec3(0.068, 0.094, 0.038),
    detail.macro,
  )

  // Stones sit in the sward, so they carry its shadow at their base and are
  // never brighter than the rock they broke from.
  const stoneColour = freshRock
    .mul(0.48)
    .mul(mix(float(0.72), float(1.15), detail.pebbleId))
  const stoneMask = smoothstep(0.3, 0.62, detail.looseStone)

  const grassAlbedo = mix(
    mix(
      mix(litter, liveTurf, tussock).mul(bladeShade),
      bareEarth,
      thinning.mul(0.55),
    ),
    stoneColour,
    stoneMask,
  )
  // Dry sward: the same structure, with the living fraction bleached out. The
  // contrast between this and green turf along a drainage line is the strongest
  // vegetation cue a mountainside has.
  const meadowAlbedo = mix(
    mix(
      mix(litter.mul(1.04), mix(litter, liveTurf, float(0.3)), tussock).mul(bladeShade),
      bareEarth.mul(1.1),
      thinning.mul(0.6),
    ),
    stoneColour.mul(1.06),
    stoneMask,
  )
  const soilAlbedo = mix(
    bareEarth,
    mix(bareEarth, litter, float(0.45)),
    detail.macro,
  )

  // --- snow --------------------------------------------------------------
  const snowAlbedo = vec3(0.7, 0.73, 0.78)
    .mul(mix(float(0.9), float(1.03), detail.macro))
    .mul(mix(float(0.94), float(1.02), detail.clump))

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
    .mul(resolved.rock.add(resolved.scree).add(resolved.soil).clamp(0, 1))
    .mul(falloff(0.72, 0.2, weights.slope).mul(0.5).add(0.5))
    .clamp(0, 1)
    .toVar('wetness')
  albedo.mulAssign(mix(vec3(1), vec3(0.48, 0.5, 0.54), wetness))

  const roughness = float(0).toVar('roughness')
  roughness.addAssign(float(SURFACE_LAYERS.grass.roughness).mul(resolved.grass))
  roughness.addAssign(float(SURFACE_LAYERS.meadow.roughness).mul(resolved.meadow))
  roughness.addAssign(float(SURFACE_LAYERS.soil.roughness).mul(resolved.soil))
  // Broken talus scatters light very differently from the polished face above
  // it, which is most of what makes a fan legible at distance.
  roughness.addAssign(
    float(SURFACE_LAYERS.scree.roughness).add(0.1).mul(resolved.scree),
  )
  roughness.addAssign(float(SURFACE_LAYERS.rock.roughness).mul(resolved.rock))
  roughness.addAssign(float(SURFACE_LAYERS.snow.roughness).mul(resolved.snow))
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

  // Cavity occlusion from the relief itself: anything sitting below the local
  // mean height is darkened, which is what sells crack and joint depth.
  const rockCavity = detail.crack.mul(0.4).add(detail.blocks.mul(0.3)).add(detail.strata.mul(0.2))
  // Grass self-occludes between clumps, and stones sit in their own shadow.
  const turfCavity = detail.clump
    .mul(0.34)
    .add(detail.blade.mul(0.2))
    .add(falloff(0.6, 0.3, detail.looseStone).mul(0.06))
    .add(0.16)
  const cavity = clamp(
    mix(turfCavity, rockCavity, resolved.rock.add(resolved.scree).clamp(0, 1)).add(0.3),
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
