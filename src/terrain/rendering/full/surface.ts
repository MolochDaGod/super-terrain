import {
  If,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  max,
  mix,
  mx_noise_float,
  normalize,
  smoothstep,
  vec3,
} from 'three/tsl'
import { cells, detailFade, fadeToMean, falloff, fbmLod, ridgedLod, warp } from './fields'

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

export const SURFACE_LAYERS = {
  grass: { name: 'grass', albedo: [0.043, 0.072, 0.026], roughness: 0.95, relief: 0.11 },
  meadow: { name: 'meadow', albedo: [0.092, 0.089, 0.041], roughness: 0.93, relief: 0.09 },
  soil: { name: 'soil', albedo: [0.041, 0.029, 0.019], roughness: 0.9, relief: 0.04 },
  scree: { name: 'scree', albedo: [0.078, 0.071, 0.062], roughness: 0.85, relief: 0.2 },
  rock: { name: 'rock', albedo: [0.086, 0.083, 0.078], roughness: 0.76, relief: 0.55 },
  snow: { name: 'snow', albedo: [0.6, 0.615, 0.64], roughness: 0.72, relief: 0.14 },
} satisfies Record<string, SurfaceLayer>

/** Blend sharpness for the height-based layer resolve, in metres. */
const HEIGHT_BLEND_DEPTH = 0.07

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
 * Geometry-driven layer coverage.
 *
 * The thresholds are perturbed at three frequencies, not one. A single
 * low-frequency mask produces the "camouflage decal" look — crisp blobs of flat
 * colour — because the boundary is smooth at every scale it is viewed from.
 * Adding metre-scale perturbation to the *input* of the threshold gives
 * boundaries that stay ragged however close the camera gets.
 */
export function layerWeights(
  position: any,
  normal: any,
  footprint: any,
): LayerWeights {
  const slope = clamp(normal.y.oneMinus(), 0, 1).toVar('slope')
  const altitude = position.y

  const regional = mx_noise_float(position.mul(0.011)).mul(0.5)
  const patch = fbmLod(position, float(46), 3, footprint).toVar('patchField')
  const moisture = fbmLod(position, float(150), 3, footprint).toVar('moisture')
  // One ragged-edge field, reused by every threshold in this function. Three
  // separate break-up noises at neighbouring frequencies cost three times as
  // much and are indistinguishable once they are all multiplied into masks.
  const raw = fbmLod(position, float(3.0), 4, footprint).sub(0.5).toVar('rawFray')
  const fray = raw.mul(0.22).toVar('fray')

  const slopeNoisy = slope.add(regional.mul(0.1)).add(fray).toVar('slopeNoisy')

  const rock = smoothstep(0.26, 0.5, slopeNoisy)
    .add(smoothstep(0.55, 0.86, slopeNoisy).mul(0.6))
    .clamp(0, 1)
    .toVar('wRock')

  const exposed = rock.oneMinus().toVar()

  // Talus collects on the moderate ground under a face: steep enough to be
  // bare, shallow enough for debris to come to rest. Reference B's cliffs all
  // stand on a fan of it, and its absence is what makes rock look like it grew
  // out of the grass.
  const deposition = smoothstep(0.16, 0.38, slopeNoisy)
    .mul(falloff(0.62, 0.4, slopeNoisy))
    .toVar('deposition')
  const scree = deposition
    .mul(exposed)
    .mul(smoothstep(0.24, 0.62, patch.add(fray).add(regional.mul(0.4))))
    .toVar('wScree')

  const remaining = exposed.mul(scree.oneMinus()).toVar()

  const soil = remaining
    .mul(smoothstep(0.58, 0.86, patch.add(regional.mul(0.3)).add(fray)))
    .mul(falloff(0.55, 0.2, moisture))
    .toVar('wSoil')

  // Turf cannot hold on a face; without this it floats as soft blobs on 50°
  // rock, which is the classic give-away of an alpha-blended splat map.
  const holdable = falloff(0.42, 0.2, slopeNoisy).toVar('holdable')
  const vegetated = remaining.mul(soil.oneMinus()).mul(holdable).toVar()

  // Vegetation thins out with altitude the way an alpine treeline does.
  const alpineFade = falloff(268, 158, altitude.add(regional.mul(38)).add(fray.mul(24)))
  // Break the lush/dry transition with clump-scale noise so it interlocks in
  // tongues and worn patches instead of dissolving across tens of metres.
  const wearing = raw.mul(0.6)
  const lush = smoothstep(0.3, 0.58, moisture.add(wearing)).mul(alpineFade)
  const grass = vegetated.mul(lush).toVar('wGrass')
  const meadow = vegetated.mul(lush.oneMinus()).toVar('wMeadow')

  // Snow only holds high up and only where the ground is flat enough to keep
  // it; on faces it slides off and leaves bare rock, as in the references.
  // The snow line needs metre-scale break-up or it snaps to the mesh triangles
  // it is evaluated across and the patches come out as polygonal shards.
  const snowEdge = raw.mul(30).toVar('snowEdge')
  // The slope term comes from the interpolated vertex normal, which is faceted
  // at coarse LOD; without its own break-up the snow patches inherit the mesh
  // triangles as straight edges.
  // Coverage is deliberately wide-blended in both altitude and slope. A narrow
  // threshold snaps to whatever resolution the underlying quantity has — here
  // the interpolated vertex normal — and the patches come out as flat polygons
  // with aliased straight edges.
  const snow = smoothstep(
    262,
    386,
    altitude.add(regional.mul(44)).add(fray.mul(30)).add(snowEdge),
  )
    .mul(falloff(0.62, 0.16, slope.add(snowEdge.mul(0.01))))
    .toVar('wSnow')

  const snowFree = snow.oneMinus()
  const lichen = fbmLod(position, float(9), 3, footprint)
    .mul(smoothstep(0.28, 0.72, moisture))
    .toVar('lichen')

  return {
    grass: grass.mul(snowFree),
    meadow: meadow.mul(snowFree),
    soil: soil.mul(snowFree),
    scree: scree.mul(snowFree),
    rock: rock.mul(snowFree),
    snow,
    slope,
    moisture,
    lichen,
  }
}

export interface SurfaceDetail {
  /** Combined relief height in metres, used for blending and parallax. */
  height: any
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
  weights: LayerWeights,
  footprint: any,
): SurfaceDetail {
  // --- macro band: survives to the horizon --------------------------------
  const macro = fbmLod(position, float(34), 3, footprint).toVar('macroField')
  // Erosion runnels down the fall line: the strongest large-scale cue that a
  // slope is rock and not a smooth heightmap.
  const outcrop = ridgedLod(
    position.mul(vec3(1, 0.35, 1)),
    float(17),
    3,
    footprint,
  ).toVar('outcrop')

  // --- strata: continuous bedding planes ---------------------------------
  // Banding is a function of world height (plus a tilt and a slow warp), so a
  // band stays continuous across a whole cliff face and across section seams.
  // Strong warp first: unwarped bedding reads as corduroy because every band
  // is a perfectly straight line of identical thickness.
  const bedded = warp(
    warp(position, float(9.5), float(0.021)),
    float(1.6),
    // Incommensurate with the first warp's frequency, so the two never line up
    // into a repeating plaid.
    float(0.1373),
  )

  // Bedding is a stack of *dipping planes* cutting through the rock mass, not a
  // set of height contours painted on the surface. The distinction is the whole
  // difference between strata and a topographic map: because the planes are
  // tilted 15–40 degrees away from horizontal and the topography is not, the
  // bands cut obliquely across slopes and terminate against faces of a
  // different orientation, exactly as they do on a real cliff.
  const dipAngle = mix(
    float(0.26),
    float(0.7),
    fbmLod(position, float(900), 1, float(0)),
  ).toVar('dipAngle')
  const dipAzimuth = fbmLod(position, float(1_400), 1, float(0))
    .mul(6.283)
    .toVar('dipAzimuth')
  const beddingNormal = vec3(
    dipAzimuth.sin().mul(dipAngle.sin()),
    dipAngle.cos(),
    dipAzimuth.cos().mul(dipAngle.sin()),
  ).toVar('beddingNormal')

  // Bed thickness drifts regionally so one massif is not a single printed
  // pattern stretched over everything.
  const bedThickness = mix(
    float(4.5),
    float(13),
    fbmLod(position, float(420), 1, float(0)),
  ).toVar('bedThickness')
  const bandDepth = bedded.dot(beddingNormal).div(bedThickness).toVar('bandDepth')
  // Irregular bed thickness: displacing the band coordinate by noise *of the
  // band coordinate* keeps beds continuous while making no two the same size.
  // The displacement has to stay well below one band per band, or successive
  // beds fold through each other and the banding dissolves into mush.
  const bandCoordinate = bandDepth
    .add(fbmLod(vec3(bandDepth.mul(0.11), 4.7, 1.3), float(1), 1, float(0)).sub(0.5).mul(0.7))
    .toVar('bandCoordinate')
  const strataBand = bandCoordinate.fract().toVar('strataBand')
  // Alternating hard and soft beds: hard ones stand proud and hold an edge.
  const bedHardness = fbmLod(
    vec3(bandCoordinate.floor().mul(1.7), 0, 0),
    float(1),
    2,
    float(0),
  ).toVar('bedHardness')
  const bedProfile = smoothstep(0.0, 0.3, strataBand)
    .mul(falloff(1.0, 0.62, strataBand))
    .toVar('bedProfile')
  // The bench profile is what actually produces a shadow line: a short, steep
  // riser at the base of each bed and a near-flat tread above it. A smooth
  // sinusoid across the whole band, which is what a plain profile gives, tilts
  // the normal by a degree or two and disappears.
  // Only part of a massif is bedded rock at the surface; elsewhere it is
  // massive, jointed or covered. Gating by slow noise keeps the benches from
  // ringing the whole mountain like contour lines on a map.
  const bedExposure = smoothstep(
    0.22,
    0.58,
    fbmLod(position, float(85), 3, footprint),
  ).toVar('bedExposure')
  const bedStep = smoothstep(0.0, 0.16, strataBand)
    .mul(mix(float(0.45), float(1.15), bedHardness))
    .mul(bedExposure)
    .toVar('bedStep')
  const strata = mix(float(0.3), float(1), bedProfile)
    .mul(mix(float(0.45), float(1), bedHardness))
    // Beds only exist where rock is actually exposed; on turf this term would
    // otherwise print contour lines across the grass.
    .mix(float(0.5), weights.rock.oneMinus().mul(0.85))
    .toVar('strata')

  // --- meso band: rock blocks and boulders --------------------------------
  // Jointing is not uniform: whole stretches of a face are massive and smooth,
  // others are broken into blocks. Modulating the amount by bed hardness and by
  // slow noise is what stops this reading as one repeating texture.
  const jointing = fbmLod(position, float(24), 2, footprint)
    .mul(mix(float(0.45), float(1.15), bedHardness))
    .toVar('jointing')
  const blocks = float(0.25).toVar('blocks')
  If(footprint.lessThan(4.4), () => {
    const blockCell = cells(warp(position, float(0.55), float(0.35)).mul(0.55))
    blocks.assign(
      fadeToMean(
        falloff(0.62, 0.12, blockCell.z.sub(blockCell.x)).mul(
          smoothstep(0.35, 0.75, jointing),
        ),
        float(0.25),
        detailFade(footprint, float(1.8)),
      ),
    )
  })

  // Buttress-scale structure: the 6–20 m ribs and gullies that give a cliff its
  // large-form silhouette shading long before any block detail is resolvable.
  const buttress = ridgedLod(
    warp(position, float(11), float(0.02)).mul(vec3(1, 0.6, 1)),
    float(9),
    3,
    footprint,
  ).toVar('buttress')

  // --- micro band: cracks, pebbles, clumps --------------------------------
  // Every band below is band-limited and dissolves to its own mean once a pixel
  // is wider than the features in it. Beyond that point evaluating it is pure
  // waste, and on a landscape most of the screen is beyond it — so the whole
  // block is skipped rather than computed and then faded. The branch is on view
  // footprint, which varies smoothly across the screen, so it stays coherent.
  const crack = float(0.5).toVar('crack')
  const pebble = float(0.35).toVar('pebble')
  const pebbleId = float(0.5).toVar('pebbleId')
  const clump = float(0.5).toVar('clump')

  If(footprint.lessThan(2.4), () => {
    crack.assign(ridgedLod(position, float(0.9), 4, footprint))
    clump.assign(
      fbmLod(
        warp(position, float(0.4), float(0.9)).mul(vec3(1, 0.45, 1)),
        float(0.34),
        5,
        footprint,
      ),
    )

    If(footprint.lessThan(0.42), () => {
      const pebbleCell = cells(warp(position, float(0.06), float(2.7)).mul(5.5))
      pebble.assign(
        fadeToMean(
          falloff(0.55, 0.06, pebbleCell.x),
          float(0.35),
          detailFade(footprint, float(0.16)),
        ),
      )
      pebbleId.assign(pebbleCell.y)
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
  const blade = float(0.5).toVar('blade')
  const looseStone = float(0.04).toVar('looseStone')
  // 0.7 m is where `looseStone`'s own fade has fully dissolved it; branching
  // any earlier cuts the band while it is still contributing, and the cut edge
  // is visible as a dashed line across the slope.
  If(footprint.lessThan(0.7), () => {
    blade.assign(fbmLod(warp(position, float(0.09), float(3.5)), float(0.075), 3, footprint))
    // Sparse: only the cells whose centre falls very close to the sample make a
    // stone, so most of the turf stays clear instead of being cobbled over.
    looseStone.assign(
      fadeToMean(
        falloff(0.2, 0.03, cells(warp(position, float(0.1), float(1.7)).mul(2.4)).x),
        float(0.04),
        detailFade(footprint, float(0.28)),
      ),
    )
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
  const microHeights = {
    grass: clump.mul(SURFACE_LAYERS.grass.relief),
    meadow: clump.mul(0.7).add(macro.mul(0.3)).mul(SURFACE_LAYERS.meadow.relief),
    soil: macro.mul(SURFACE_LAYERS.soil.relief),
    scree: pebble.mul(0.7).add(blocks.mul(0.3)).mul(SURFACE_LAYERS.scree.relief),
    rock: crack.mul(0.5).add(strata.mul(0.5)).mul(SURFACE_LAYERS.rock.relief),
    // Snow drifts fill hollows: high, smooth, and it buries what is beneath.
    snow: macro.mul(0.35).add(0.65).mul(SURFACE_LAYERS.snow.relief).add(0.3),
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

  return {
    height,
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
    // A layer with no coverage must never win, hence the large negative bias.
    const score = coverage.mul(0.5).add(heights[key]).add(coverage.sub(1).mul(4)).toVar()
    scores[key] = score
    peak.assign(max(peak, score))
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
  position: any,
  weights: LayerWeights,
  surface: SurfaceDetail,
  footprint: any,
): { albedo: any; roughness: any; cavity: any } {
  const { detail, resolved } = surface

  // --- rock --------------------------------------------------------------
  // Each bed gets its own colour, keyed off the bed's own identity rather than
  // off the profile within it, so a band holds one rock type from end to end.
  // Beds differ in value *and* hue: pale dolomite against darker, warmer
  // mudstone. A pure value ramp reads as dirt on one rock instead of as strata.
  // A real sequence is several rock types, not one rock at two brightnesses.
  // Each bed picks from a small palette by its own identity, so a band holds
  // one lithology from end to end and neighbours contrast in hue as well as
  // value — pale dolomite, blue-grey limestone, iron-stained marl, dark shale.
  const bedType = detail.bedHardness
  const paleDolomite = vec3(0.092, 0.086, 0.072)
  const blueLimestone = vec3(0.044, 0.049, 0.056)
  const ironMarl = vec3(0.062, 0.040, 0.026)
  const darkShale = vec3(0.017, 0.016, 0.018)
  const bedTint = mix(
    mix(darkShale, ironMarl, smoothstep(0.0, 0.36, bedType)),
    mix(blueLimestone, paleDolomite, smoothstep(0.62, 1.0, bedType)),
    smoothstep(0.3, 0.66, bedType),
  )
  // Partings: the base of each bed is a recessed, dirt-filled joint.
  const parting = falloff(0.35, 0.0, detail.bedProfile).mul(detail.bedExposure).mul(0.3)
  // Oxidation runs and lichen colonies at 5–20 m: the scale that stops a face
  // reading as one painted surface once the micro detail has faded with range.
  const mottle = fbmLod(position, float(14), 2, footprint).toVar('mottle')
  const ironStain = mix(
    vec3(1, 1, 1),
    vec3(1.28, 0.86, 0.54),
    smoothstep(0.5, 0.92, mottle.mul(0.6).add(detail.macro.mul(0.4))).mul(0.85),
  )
  // Shading multipliers are centred on 1 so they add variation without
  // ratcheting the whole surface brighter.
  const blockShade = mix(float(0.66), float(1.1), detail.blocks)
  const buttressShade = mix(float(0.6), float(1.08), detail.buttress)
  const rockBase = bedTint
    .mul(ironStain)
    .mul(blockShade)
    .mul(buttressShade)
    .mul(parting.oneMinus())
  // Crack interiors are darker and damper than the faces around them.
  const crackDarken = falloff(0.55, 0.12, detail.crack).mul(0.55)
  const rockCracked = rockBase.mul(crackDarken.oneMinus().max(0.35))
  const lichenColour = mix(vec3(0.062, 0.081, 0.038), vec3(0.115, 0.118, 0.072), detail.clump)
  const lichenMask = weights.lichen
    .mul(smoothstep(0.4, 0.85, mottle))
    .mul(smoothstep(0.35, 0.8, detail.crack))
    .mul(falloff(0.85, 0.25, weights.slope))
    .mul(smoothstep(0.35, 0.7, detail.macro))
  const rockAlbedo = mix(rockCracked, lichenColour, lichenMask.mul(0.7))

  // --- scree -------------------------------------------------------------
  // Freshly broken stone is lighter and warmer than the weathered face above.
  const pebbleTint = mix(vec3(0.068, 0.060, 0.048), vec3(0.128, 0.118, 0.098), detail.pebbleId)
  const screeAlbedo = mix(
    vec3(0.05, 0.044, 0.035),
    pebbleTint,
    smoothstep(0.15, 0.7, detail.pebble),
  ).mul(mix(float(0.82), float(1.12), detail.macro))

  // --- vegetation --------------------------------------------------------
  // Turf is never one colour: blade clumps self-shade, and the hue drifts from
  // yellow-green on dry knolls to blue-green in the hollows.
  const clumpShade = mix(float(0.66), float(1.22), detail.clump)
  const grassHue = mix(vec3(0.024, 0.055, 0.016), vec3(0.062, 0.094, 0.028), detail.macro)
  const stoneColour = vec3(0.115, 0.108, 0.096).mul(mix(float(0.78), float(1.2), detail.pebbleId))
  const bladeShade = mix(float(0.82), float(1.14), detail.blade)
  const grassAlbedo = mix(
    grassHue.mul(clumpShade).mul(bladeShade),
    stoneColour,
    smoothstep(0.25, 0.7, detail.looseStone),
  )
  const meadowHue = mix(vec3(0.058, 0.062, 0.028), vec3(0.104, 0.098, 0.044), detail.macro)
  const meadowAlbedo = mix(
    meadowHue.mul(mix(float(0.72), float(1.2), detail.clump)).mul(bladeShade),
    stoneColour.mul(1.06),
    smoothstep(0.35, 0.85, detail.looseStone),
  )
  const soilAlbedo = mix(vec3(0.034, 0.024, 0.016), vec3(0.058, 0.042, 0.028), detail.macro)

  // --- snow --------------------------------------------------------------
  // Real snow is bright but not white in linear terms; letting it run to 1.0
  // clips before the tone curve can shape it.
  const snowAlbedo = vec3(0.6, 0.615, 0.64)
    .mul(mix(float(0.86), float(1.06), detail.macro))
    .mul(mix(float(0.92), float(1.04), detail.clump))

  const albedo = vec3(0).toVar('albedo')
  albedo.addAssign(grassAlbedo.mul(resolved.grass))
  albedo.addAssign(meadowAlbedo.mul(resolved.meadow))
  albedo.addAssign(soilAlbedo.mul(resolved.soil))
  albedo.addAssign(screeAlbedo.mul(resolved.scree))
  albedo.addAssign(rockAlbedo.mul(resolved.rock))
  albedo.addAssign(snowAlbedo.mul(resolved.snow))

  // Slow, large-scale value variation over everything: nothing in nature holds
  // one reflectance across a whole hillside.
  const regionalTint = fbmLod(position, float(220), 2, footprint)
  albedo.mulAssign(mix(float(0.78), float(1.1), regionalTint))

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
  roughness.subAssign(resolved.rock.mul(falloff(0.5, 0.12, detail.crack)).mul(0.2))
  roughness.subAssign(
    resolved.rock.mul(smoothstep(0.45, 0.95, detail.bedHardness)).mul(0.22),
  )

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
 * Compact relief height used only for the normal gradient.
 *
 * The full layer stack is far too expensive to evaluate for the normal — doing
 * so was costing more than everything else in the frame combined. This keeps
 * the bands that actually bend the normal (bedding step, buttress ribs, cracks,
 * turf clumps) and drops everything that only affects colour, which the
 * gradient never sees anyway. It has to stay *consistent* with the real relief,
 * not identical to it: a normal that leans the same way as the surface reads
 * correctly even if its amplitude is approximate.
 *
 * Deliberately branch-free: its screen-space derivatives are taken below, and
 * derivatives of a value computed under divergent control flow are undefined.
 */
export function reliefProxy(
  position: any,
  weights: LayerWeights,
  footprint: any,
): any {
  const rocky = weights.rock.add(weights.scree.mul(0.7)).clamp(0, 1)

  const bedded = warp(position, float(9.5), float(0.021))
  const bandDepth = bedded.y.add(bedded.x.mul(0.2)).add(bedded.z.mul(0.1)).div(7.5)
  const bedStep = smoothstep(0.0, 0.16, bandDepth.fract())
  const buttress = ridgedLod(position.mul(vec3(1, 0.6, 1)), float(9), 2, footprint)
  const crack = ridgedLod(position, float(0.9), 3, footprint)
  const rockHeight = bedStep.mul(0.5).add(buttress.mul(1.1)).add(crack.mul(0.09))

  const turfHeight = fbmLod(position, float(34), 2, footprint)
    .mul(0.5)
    .add(fbmLod(position.mul(vec3(1, 0.45, 1)), float(0.34), 3, footprint).mul(0.09))

  return mix(turfHeight, rockHeight, rocky)
}

/**
 * World-space normal perturbation from the relief gradient.
 *
 * The height field is sampled once and differentiated in screen space rather
 * than being re-sampled along two tangents. Three taps of even a compact height
 * function is the single most expensive thing this material can do; the
 * derivative form (Mikkelsen's surface gradient for unparametrised meshes)
 * gets the same gradient from the values the neighbouring pixels in the quad
 * already computed, and costs two derivative instructions.
 */
function fineRelief(position: any, weights: LayerWeights, footprint: any): any {
  const turf = weights.grass.add(weights.meadow).add(weights.soil).clamp(0, 1)
  const blade = fbmLod(warp(position, float(0.09), float(3.5)), float(0.075), 3, footprint)
  const stone = falloff(
    0.2,
    0.03,
    cells(warp(position, float(0.1), float(1.7)).mul(2.4)).x,
  )
  const crack = ridgedLod(position, float(0.22), 2, footprint)
  return mix(crack.mul(0.02), blade.mul(0.018).add(stone.mul(0.06)), turf)
}

export function reliefNormal(
  position: any,
  normal: any,
  weights: LayerWeights,
  footprint: any,
  strength: any,
): any {
  const height = reliefProxy(position, weights, footprint).toVar('reliefHeightProxy')

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

  // Screen-space derivatives cannot express anything finer than a pixel quad,
  // so blades, grit and hairline cracks vanish exactly where the camera is
  // close enough to want them. Near the camera those bands get an explicit
  // two-tap gradient instead — affordable precisely because it is near-only.
  If(footprint.lessThan(0.05), () => {
    const epsilon = max(footprint.mul(1.5), float(0.004)).toVar('fineEpsilon')
    const up = vec3(shaded.y.abs().greaterThan(0.95).select(vec3(1, 0, 0), vec3(0, 1, 0)))
    const tangent = normalize(cross(up, shaded)).toVar('fineTangent')
    const bitangent = normalize(cross(shaded, tangent)).toVar('fineBitangent')
    const centre = fineRelief(position, weights, footprint)
    const gradient = tangent
      .mul(fineRelief(position.add(tangent.mul(epsilon)), weights, footprint).sub(centre))
      .add(
        bitangent.mul(
          fineRelief(position.add(bitangent.mul(epsilon)), weights, footprint).sub(centre),
        ),
      )
      .div(epsilon)
    shaded.assign(normalize(shaded.sub(gradient.mul(strength.mul(0.6)))))
  })

  return shaded
}
