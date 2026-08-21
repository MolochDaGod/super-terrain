import type { SurfaceRecipe } from '../bake'
import { blurField, createField, type Field, fillField, stretchField } from '../field'
import { bilateralSmooth, hydraulicErosion, thermalErosion } from '../erosion'
import { clamp01, fbm, hashInt, mix, smoothstep } from '../noise'
import { beddingField, jointSets, lichenField, pittedSurface, speckleField } from '../common'
import { flowAccumulation, runoffStain, siltDeposit, upFacing } from '../weathering'
import { mixRgb, srgbHex, type Rgb } from '../encode'

/**
 * A bedded sandstone cliff face.
 *
 * Deposition laid down beds of differing hardness, brittle failure cut a
 * joint set across them, and weathering then worked back the soft beds and
 * levered blocks out along the joints. The joint network is sampled in the
 * bedding coordinate, so every block boundary terminates against a bed rather
 * than running through the whole face — the single structural detail that
 * separates a jointed cliff from a crazed one. The bed index survives into
 * shading, giving each layer its own lithology.
 */

interface BedLithology {
  colour: Rgb
  /** How far the bed weathers back, in height units. */
  recession: number
  roughness: number
  /** Height offset of the whole bed. */
  step: number
  /** 0 soft and friable, 1 well cemented. Drives grain and pitting. */
  hardness: number
}

function bedLithology(bed: number, seed: number): BedLithology {
  const h = hashInt(bed * 2654435761 + seed)
  const hard = ((h >>> 11) & 0xff) / 255
  const iron = ((h >>> 19) & 0xff) / 255
  const value = ((h >>> 3) & 0xff) / 255
  // A single sandstone, varying in iron content and cementation.
  const base = mixRgb(srgbHex(0xa8834e), srgbHex(0x92603a), Math.pow(iron, 1.6))
  const lift = mix(0.82, 1.18, value)
  return {
    colour: { r: base.r * lift, g: base.g * lift * 0.99, b: base.b * lift * 0.96 },
    recession: mix(0.2, 0, Math.pow(hard, 0.8)),
    roughness: mix(0.95, 0.76, hard),
    step: (value - 0.5) * 0.17,
    hardness: hard,
  }
}

export const cliffSideRecipe: SurfaceRecipe = {
  id: 'cliff-side',
  physicalWidth: 1.8,
  reliefDepth: 0.17,

  build(size, seed) {
    const s = size / 1024
    const bedCount = 11
    const bedding = beddingField(size, bedCount, seed + 13, {
      wander: 0.035,
      wanderPeriod: 3,
      dip: 0.05,
    })

    // Bedding coordinate in tile units. Blocks sampled against it cannot
    // cross a parting.
    const bedCoord = createField(size)
    for (let i = 0; i < bedCoord.data.length; i += 1) {
      bedCoord.data[i] = (bedding.index.data[i]! + bedding.phase.data[i]!) / bedCount
    }

    // Three joint sets, sampled in the bedding coordinate so their traces
    // terminate against partings instead of running through the whole face.
    // A bedding-normal set gives the horizontal partings, a bedding-parallel
    // set the vertical joints that split each bed into slabs, and an oblique
    // set the shorter cross fractures.
    const mosaic = jointSets(
      size,
      [
        {
          nx: 0,
          ny: 1,
          count: bedCount,
          presence: 0.85,
          amplitude: 0.3,
          tilt: 0.2,
          wander: 0.018,
          wanderPeriod: 3,
          continuity: 0.95,
          aperture: 1.5,
        },
        {
          nx: 1,
          ny: 0,
          count: 6,
          presence: 0.7,
          amplitude: 0.24,
          tilt: 0.3,
          wander: 0.05,
          wanderPeriod: 4,
          continuity: 0.62,
          aperture: 1.2,
        },
        {
          nx: 2,
          ny: 1,
          count: 9,
          presence: 0.28,
          amplitude: 0.04,
          tilt: 0.3,
          wander: 0.05,
          wanderPeriod: 5,
          continuity: 0.3,
          aperture: 0.6,
        },
      ],
      seed + 23,
      bedCoord,
    )

    // Granular pitting across four scales, from millimetre grain sockets to
    // centimetre solution hollows.
    const pits = pittedSurface(size, seed + 601, [
      { cells: 20, depth: 0.05, density: 0.16 },
      { cells: 48, depth: 0.032, density: 0.24 },
      { cells: 120, depth: 0.02, density: 0.34 },
      { cells: 290, depth: 0.012, density: 0.45 },
      { cells: 680, depth: 0.007, density: 0.55 },
    ])

    const base = createField(size)
    const spall = createField(size)
    const bedIndex = bedding.index
    const bedPhase = bedding.phase
    // The lithology is resolved once, here, and handed to the shading stage
    // as fields. Re-deriving it there from the bed index alone silently used
    // a different seed, so every bed was weathered as one rock and coloured
    // as another — precisely the decoupling of colour from form that makes a
    // face look painted.
    const bedRed = createField(size)
    const bedGreen = createField(size)
    const bedBlue = createField(size)
    const bedHardness = createField(size)

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x
        const u = x / size
        const v = y / size
        const bed = bedIndex.data[i]!
        const litho = bedLithology(bed, seed)
        const phase = bedPhase.data[i]!
        bedRed.data[i] = litho.colour.r
        bedGreen.data[i] = litho.colour.g
        bedBlue.data[i] = litho.colour.b
        bedHardness.data[i] = litho.hardness

        // Differential weathering: soft beds sit back, and every parting
        // opens into a recess as the bed above and below round over.
        const partingWear =
          (smoothstep(0.12, 0, phase) + smoothstep(0.88, 1, phase)) *
          clamp01(fbm(u * 6, v * 6, 6, seed + 191, { octaves: 3 }) * 1.4 + 0.6)
        let h = litho.step - litho.recession - partingWear * 0.075

        // The block mosaic carries the bulk of the relief.
        h += mosaic.height.data[i]! * 1.25
        // Joints pinch out along their length instead of holding one width
        // for their whole run, which is what made the earlier pass read as a
        // drawn crack network.
        const jointOpen = clamp01(fbm(u * 8, v * 8, 8, seed + 211, { octaves: 4 }) * 1.3 + 0.45)
        const carve = mosaic.carve.data[i]!
        h -= carve * jointOpen * 0.34
        // Joints do not stay clean. Grus weathered off the walls collects in
        // the bottom, so the floor of an open joint is an irregular fill
        // rather than the clean vee the carve leaves behind.
        const infill = clamp01(fbm(u * 26, v * 26, 26, seed + 271, { octaves: 4 }) * 0.9 + 0.55)
        h += carve * carve * jointOpen * 0.34 * infill * 0.55

        // Spalls: whole blocks that have come away, exposing the fresher,
        // rougher rock behind. Keying them to the block mosaic rather than to
        // an independent blob mask is what gives the scars the angular,
        // joint-bounded outline of real rockfall instead of soft cloudy
        // patches floating across the face.
        const block = mosaic.blockId.data[i]!
        const spalled = block < 0.2 ? 1 : 0
        const spallMask =
          spalled * smoothstep(0.02, 0.16, mosaic.interior.data[i]!)
        spall.data[i] = spallMask
        h -= spallMask * 0.075

        // Cross-lamination inside each bed, and the sandstone grain itself.
        // Every block has weathered for a different length of time, so the
        // amount of surface relief varies from face to face.
        const lam = fbm(u * 4, phase * 7 + bed * 3.3, 4, seed + 101, { octaves: 3, stretchY: 0.35 })
        h += lam * 0.012
        const roughFace = 0.35 + mosaic.blockId.data[i]! * 1.3
        h += fbm(u * 90, v * 90, 90, seed + 5, { octaves: 4 }) * 0.012 * roughFace
        // Pitting, weighted by how long the face has been exposed, how well
        // cemented the bed is, and opened right up inside a spall scar. A
        // poorly cemented bed frets away; a hard one keeps a clean face.
        h += pits.data[i]! *
          (0.35 + roughFace * 0.45) *
          mix(1.7, 0.5, litho.hardness) *
          (1 + spallMask * 0.8)
        // Small flakes lifting off the face.
        h -= smoothstep(0.62, 0.78, fbm(u * 44, v * 44, 44, seed + 233, { octaves: 3 }) * 0.5 + 0.5) * 0.02

        base.data[i] = h
      }
    }

    // A light, diffuse rain wash. The flow is deliberately unbiased: a
    // downhill bias makes every droplet erode along its whole path, and the
    // tracks then show up in the normal map as long smooth arcs.
    const eroded = hydraulicErosion(base, {
      droplets: Math.round(160_000 * s * s),
      maxSteps: 55,
      // A wide brush and a low rate keep this a diffuse loss of material.
      // Sharpening either one makes each droplet leave a legible scratch,
      // which the normal map then advertises as a comet trail.
      erosionRadius: Math.max(2, Math.round(4.5 * s)),
      capacity: 2.6,
      erodeRate: 0.035,
      depositRate: 0.5,
      evaporation: 0.014,
      inertia: 0.18,
      seed: seed + 17,
    })
    // Just enough creep to break the sharpest corners. Run longer, thermal
    // erosion relaxes every block step into a smooth ramp, and a ramp tilted
    // into the light is a bright band tracing the outline of each block —
    // the surface then reads as polygons drawn on rock rather than as rock
    // that has broken into polygons.
    const settled = thermalErosion(eroded.height, {
      iterations: 6,
      talusAngle: 0.055 / s,
      rate: 0.4,
    })
    // Flatten the block faces without rounding the joints back off.
    const faceted = bilateralSmooth(settled, Math.max(1, 1.2 * s), 0.014, 1)

    const height = stretchField(faceted, 0.003, 0.997)
    const speckle = speckleField(size, seed + 313)
    const lichen = lichenField(size, seed + 611, {
      colonies: Math.round(90 * s * s),
      minRadius: size / 120,
      maxRadius: size / 14,
      ragged: 0.85,
    })
    const mineral = fillField(size, (u, v) =>
      clamp01(fbm(u * 4, v * 11, 4, seed + 151, { octaves: 4, stretchY: 0.35 }) * 0.6 + 0.5),
    )

    return {
      height,
      normalBoost: 1,
      ao: { radius: Math.max(12, size / 18), intensity: 1.2 },
      data: {
        bedIndex,
        bedPhase,
        bedRed,
        bedGreen,
        bedBlue,
        bedHardness,
        spall,
        carve: mosaic.carve,
        block: mosaic.blockId,
        domain: mosaic.domainId,
        speckle,
        lichen,
        mineral,
      } satisfies Record<string, Field>,
    }
  },

  derive({ height, ao }, seed) {
    const s = height.size / 1024
    // Silt settles on the up-facing ledges every bed and block step makes,
    // and everything the face sheds runs down from those same ledges as a
    // stain. Both are read off the finished surface, so they land exactly on
    // the geometry the normal map shows.
    const dust = stretchField(siltDeposit(height, ao, { scale: 26, smooth: Math.max(1, 2 * s) }), 0.2, 0.99)
    const shed = upFacing(height, 22)
    const streak = stretchField(
      runoffStain(shed, { decay: 0.986, wander: height.size / 70, seed: seed + 91 }),
      0.25,
      0.99,
    )
    const drainage = stretchField(blurField(flowAccumulation(height), Math.max(1, 1.5 * s)), 0.55, 0.998)
    return { dust, streak, drainage }
  },

  shade(ctx) {
    const i = ctx.index
    const phase = ctx.data.bedPhase!.data[i]!
    const hardness = ctx.data.bedHardness!.data[i]!
    const spall = ctx.data.spall!.data[i]!
    const block = ctx.data.block!.data[i]!
    const domain = ctx.data.domain!.data[i]!
    const dust = ctx.data.dust!.data[i]!
    const streak = ctx.data.streak!.data[i]!
    const drainage = ctx.data.drainage!.data[i]!
    const speckle = ctx.data.speckle!.data[i]!
    const lichen = ctx.data.lichen!.data[i]!
    const mineral = ctx.data.mineral!.data[i]!

    // Blocks of one bed differ slightly in tone; the bed still reads as a
    // bed, but the face stops looking stencilled.
    const blockTint = mix(0.86, 1.14, block) * mix(0.93, 1.07, domain)
    let colour: Rgb = {
      r: ctx.data.bedRed!.data[i]! * blockTint,
      g: ctx.data.bedGreen!.data[i]! * blockTint * 0.99,
      b: ctx.data.bedBlue!.data[i]! * blockTint * 0.97,
    }

    // Iron mobilises through the rock and precipitates in bands and rinds.
    colour = mixRgb(colour, srgbHex(0x8a5024), clamp01(mineral * 1.3 - 0.45) * 0.34)
    // The outer millimetres of an exposed face are case-hardened, darker and
    // greyer than the fresh rock behind a spall.
    colour = mixRgb(colour, srgbHex(0x6f5c44), 0.24 * (1 - spall))
    colour = mixRgb(colour, srgbHex(0xb5945f), spall * 0.34)

    // Water tracks: damp, algae-darkened streaks below every ledge.
    const damp = clamp01(streak * 0.9 + drainage * 0.5 - 0.25)
    colour = mixRgb(colour, srgbHex(0x4a4032), damp * 0.45)

    // Pale silt and calcite dust on the up-facing steps.
    const ledge = clamp01(dust * 1.25 - 0.15) * smoothstep(0.35, 0.75, ctx.ao)
    colour = mixRgb(colour, srgbHex(0xbfae92), ledge * 0.18)

    // Fresh grains on broken edges; dark fines packed into open joints.
    colour = mixRgb(colour, srgbHex(0xd6c199), clamp01(ctx.curvature * 0.55) * 0.04)
    // Joint darkening is read off the cavity the joint actually cut, never
    // off the trace mask. Painting a dark line where there is no geometry is
    // what turns a fracture network into ink strokes on a smooth surface.
    const fissure = clamp01((1 - ctx.cavity * 1.75) * 1.1)
    colour = mixRgb(colour, srgbHex(0x4a3c2c), fissure * 0.22)

    // Quartz grain speckle and lichen on the stable, sheltered faces.
    // Grain-scale colour mottling. Real sandstone faces vary in tone over a
    // few millimetres from differential cementation; a flat wash over a
    // detailed normal map is one of the loudest synthetic cues there is.
    // Bounded, and driven by the speckle rather than by the raw height
    // residual: the residual spikes at every block step, so using it directly
    // paints a bright hairline along every edge in the mosaic.
    const mottle = clamp01(ctx.detail * 6 + 0.5) - 0.5 + (speckle - 0.5) * 0.55
    colour = {
      r: colour.r * (1 + mottle * 0.16),
      g: colour.g * (1 + mottle * 0.14),
      b: colour.b * (1 + mottle * 0.1),
    }
    const sparkle = speckle > 0.99 ? (speckle - 0.99) * 90 : 0
    const lichenMask = clamp01(lichen * smoothstep(0.55, 0.9, ctx.ao) * (1 - fissure) * 0.5)
    colour = mixRgb(colour, srgbHex(0x7d7d58), lichenMask * 0.5)

    const roughness = clamp01(
      mix(mix(0.95, 0.76, hardness), 0.92, spall * 0.6) -
        damp * 0.12 -
        sparkle * 0.25 +
        ledge * 0.05 +
        (phase < 0.06 ? 0.03 : 0),
    )

    return {
      albedo: colour,
      roughness,
      metalness: 0,
      occlusion: mix(1, 0.66, fissure),
    }
  },
}
