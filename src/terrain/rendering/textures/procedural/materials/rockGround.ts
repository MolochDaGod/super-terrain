import type { SurfaceRecipe } from '../bake'
import {
  addFields,
  blurField,
  createField,
  type Field,
  fillField,
  stretchField,
} from '../field'
import { hydraulicErosion, thermalErosion } from '../erosion'
import { clamp01, fbm, hashInt, mix, smoothstep, worley } from '../noise'
import { lichenField, scatterClasts, speckleField, strandField } from '../common'
import { flowAccumulation, siltDeposit } from '../weathering'
import { mixRgb, srgbHex, type Rgb } from '../encode'

/**
 * Dry alpine ground: a clast-supported gravel lag in a silty matrix.
 *
 * The surface is built the way the real one forms. A fine matrix is laid
 * down, a power-law population of fragments is dropped onto it, runoff then
 * washes fines out of the exposed lag and into the interstices, and thermal
 * creep settles the whole thing. Colour comes from a lithology assigned per
 * fragment, so the gravel reads as a mix of rock types rather than as one
 * tinted noise field.
 */

const MATRIX_DRY = srgbHex(0x6f6759)
const MATRIX_DAMP = srgbHex(0x453f36)
const SILT = srgbHex(0x8b8272)

/** Lithologies present in a glacial/alluvial gravel, with their frequency. */
const LITHOLOGY: Array<{ weight: number; light: Rgb; dark: Rgb; roughness: number }> = [
  // Dark basalt and hornfels chips.
  { weight: 0.24, light: srgbHex(0x4c4a46), dark: srgbHex(0x2b2a28), roughness: 0.74 },
  // Grey andesite / greywacke, the bulk of the population.
  { weight: 0.38, light: srgbHex(0x807c74), dark: srgbHex(0x53504a), roughness: 0.82 },
  // Iron-stained sandstone.
  { weight: 0.2, light: srgbHex(0x8a7259), dark: srgbHex(0x5d4a38), roughness: 0.87 },
  // Pale limestone.
  { weight: 0.14, light: srgbHex(0xa39c8e), dark: srgbHex(0x77715f), roughness: 0.84 },
  // Vein quartz; rare and conspicuous. Kept scarce — a scatter of white
  // pebbles is the fastest way to make gravel read as decorative aggregate.
  { weight: 0.04, light: srgbHex(0xb2aea2), dark: srgbHex(0x8d887c), roughness: 0.62 },
]

function pickLithology(id: number) {
  let acc = 0
  for (const entry of LITHOLOGY) {
    acc += entry.weight
    if (id <= acc) return entry
  }
  return LITHOLOGY[LITHOLOGY.length - 1]!
}

export const rockGroundRecipe: SurfaceRecipe = {
  id: 'rock-ground',
  physicalWidth: 2,
  reliefDepth: 0.055,

  build(size, seed) {
    const s = size / 1024

    // Silty matrix: broad deposition swells plus a fine grain floor.
    const matrix = fillField(size, (u, v) => {
      const broad = fbm(u * 3, v * 3, 3, seed + 1, { octaves: 4 }) * 0.5
      const medium = fbm(u * 11, v * 11, 11, seed + 2, { octaves: 4 }) * 0.22
      // The matrix is itself granular: silt with sand and grit through it,
      // not the smooth mud a plain fBm produces.
      const grain = fbm(u * 96, v * 96, 96, seed + 3, { octaves: 3 }) * 0.05
      const grit = worley(u * 190, v * 190, 190, seed + 4, 1).f1
      return broad + medium + grain + grit * 0.035
    })

    // Three clast populations spanning cobbles to grit. Sampling the same
    // power law at three scales is far cheaper than one huge scatter and
    // gives the dense interstitial packing of a real lag surface.
    const cobbles = scatterClasts(size, {
      count: Math.round(65 * s * s),
      minRadius: 13 * s,
      maxRadius: 34 * s,
      sizeBias: 2.4,
      protrusion: 0.5,
      minAspect: 1,
      maxAspect: 1.9,
      angularity: 0.6,
      facets: 3,
      seed: seed + 101,
    })
    const pebbles = scatterClasts(size, {
      count: Math.round(2200 * s * s),
      minRadius: 5 * s,
      maxRadius: 14 * s,
      sizeBias: 2.1,
      protrusion: 0.5,
      minAspect: 1,
      maxAspect: 1.7,
      angularity: 0.72,
      facets: 3,
      seed: seed + 211,
    })
    const grit = scatterClasts(size, {
      // Dense, but deliberately short of full coverage. A lag surface is
      // clast-supported, yet burying the matrix completely removes the fines
      // that hold it together and leaves the clasts looking loose.
      count: Math.round(8_000 * s * s),
      minRadius: 1.8 * s,
      maxRadius: 5 * s,
      sizeBias: 1.7,
      protrusion: 0.5,
      minAspect: 1,
      maxAspect: 1.8,
      angularity: 0.85,
      facets: 2,
      seed: seed + 331,
    })

    const clastHeight = createField(size)
    const clastId = createField(size)
    const clastMask = createField(size)
    const clastCore = createField(size)
    const clastSize = createField(size)
    const layers = [
      { result: cobbles, scale: 1, size: 1 },
      { result: pebbles, scale: 1, size: 0.55 },
      { result: grit, scale: 1, size: 0.22 },
    ]
    for (const layer of layers) {
      const { result } = layer
      for (let i = 0; i < clastHeight.data.length; i += 1) {
        const h = result.height.data[i]! * layer.scale
        if (h > clastHeight.data[i]!) {
          clastHeight.data[i] = h
          clastId.data[i] = result.id.data[i]!
          clastCore.data[i] = result.core.data[i]!
          clastSize.data[i] = layer.size
        }
        if (result.mask.data[i]! > clastMask.data[i]!) {
          clastMask.data[i] = result.mask.data[i]!
        }
      }
    }

    // Scale the clast relief against the matrix so cobbles sit proud but the
    // grit stays nearly buried, which is what makes the packing read.
    let raw = addFields(matrix, clastHeight, 1.15 / (34 * s))

    // Runoff strips fines from the crests and packs them into the gaps.
    const eroded = hydraulicErosion(raw, {
      droplets: Math.round(40_000 * s * s),
      maxSteps: 28,
      erosionRadius: Math.max(1, Math.round(2 * s)),
      capacity: 3,
      erodeRate: 0.22,
      depositRate: 0.35,
      evaporation: 0.035,
      seed: seed + 7,
    })
    raw = thermalErosion(eroded.height, {
      iterations: 5,
      talusAngle: 0.02 / s,
      rate: 0.4,
    })

    const height = stretchField(raw, 0.002, 0.998)

    // Where the lag is winnowed down to bare clasts and where it is blanketed
    // in fines varies over tens of centimetres; without that patchiness the
    // surface reads as a single manufactured aggregate.
    const patch = fillField(size, (u, v) =>
      clamp01(fbm(u * 2.5, v * 2.5, 3, seed + 401, { octaves: 4 }) * 1.5 + 0.5),
    )

    const chroma = fillField(size, (u, v) =>
      fbm(u * 7, v * 7, 7, seed + 61, { octaves: 4 }),
    )
    const speckle = speckleField(size, seed + 909)
    const strands = strandField(size, seed + 77, {
      clumps: Math.round(12 * s * s),
      strandsPerClump: 7,
      length: 26 * s,
      curl: 1.5,
    })
    const lichen = lichenField(size, seed + 505, {
      colonies: Math.round(70 * s * s),
      minRadius: size / 150,
      maxRadius: size / 26,
      ragged: 0.7,
    })

    return {
      height,
      normalBoost: 1.05,
      data: {
        clastId,
        clastMask,
        clastCore,
        clastSize,
        patch,
        chroma,
        speckle,
        strands,
        lichen,
      } satisfies Record<string, Field>,
    }
  },

  derive({ height, ao }, seed) {
    const s = height.size / 1024
    // Fines settle on the up-facing, sheltered parts of the lag; water
    // gathers in the interstices between clasts and keeps them damp.
    const silt = stretchField(
      siltDeposit(height, ao, { scale: 34, smooth: Math.max(1, 1.5 * s) }),
      0.15,
      0.985,
    )
    const damp = stretchField(
      blurField(flowAccumulation(height), Math.max(1, 2 * s)),
      0.4,
      0.995,
    )
    void seed
    return { silt, damp }
  },

  shade(ctx) {
    const i = ctx.index
    const clastMask = ctx.data.clastMask!.data[i]!
    const clastId = ctx.data.clastId!.data[i]!
    const core = ctx.data.clastCore!.data[i]!
    const clastScale = ctx.data.clastSize!.data[i]!
    const siltRaw = ctx.data.silt!.data[i]!
    const damp = ctx.data.damp!.data[i]!
    const patch = ctx.data.patch!.data[i]!
    // Fines are thicker in the sheltered patches, thinner on the winnowed
    // ones, so the same lag grades from clast-supported to matrix-supported.
    const silt = clamp01(siltRaw * (0.45 + patch * 1.25))
    const chroma = ctx.data.chroma!.data[i]!
    const speckle = ctx.data.speckle!.data[i]!
    const strand = ctx.data.strands!.data[i]!
    const lichen = ctx.data.lichen!.data[i]!

    // Matrix: silt-rich where runoff dropped fines, darker and damper in the
    // shaded interstices where water lingers.
    const dampness = clamp01(damp * 0.85 + (1 - ctx.ao) * 0.5)
    let matrix = mixRgb(MATRIX_DRY, MATRIX_DAMP, dampness * 0.55)
    matrix = mixRgb(matrix, SILT, clamp01(silt * 0.65))
    matrix = mixRgb(matrix, { r: matrix.r * 1.08, g: matrix.g * 1.05, b: matrix.b * 0.96 }, chroma * 0.5 + 0.5)

    // Fragment colour: a lithology drawn per clast, shaded from its worn
    // crown to its part-buried rim.
    const litho = pickLithology(clastId)
    const jitter = (hashInt(Math.round(clastId * 65536)) & 0xff) / 255
    const wear = clamp01(core * 0.55 + ctx.height * 0.45)
    let clast = mixRgb(litho.dark, litho.light, clamp01(wear * 0.6 + jitter * 0.75 - 0.1))
    // Sun-facing crowns of exposed fragments bleach and pick up a dust film.
    clast = mixRgb(clast, SILT, clamp01(ctx.curvature * 0.35) * 0.35 + silt * 0.18)
    clast = mixRgb(clast, MATRIX_DAMP, dampness * 0.3)

    // Fines drape the smallest fragments almost completely.
    const buried = clamp01(silt * (1 - clastScale * 0.7) * 1.15 * (0.35 + patch * 0.9))
    const exposure = clamp01(clastMask * (1 - buried * 0.7))
    let colour = mixRgb(matrix, clast, exposure)

    // Grain-level mineral speckle, deliberately decorrelated from height so
    // it does not read as a second copy of the normal map.
    const sparkle = speckle > 0.985 ? (speckle - 0.985) * 60 : 0
    colour = mixRgb(colour, srgbHex(0xd9d5c9), sparkle * 0.5)
    const grit = (speckle - 0.5) * 0.09
    colour = { r: colour.r * (1 + grit), g: colour.g * (1 + grit * 0.95), b: colour.b * (1 + grit * 0.88) }

    // Dead grass and a little crustose lichen on the stable, exposed clasts.
    colour = mixRgb(colour, srgbHex(0x8d7f5e), clamp01(strand) * 0.55)
    const lichenMask = clamp01(lichen * smoothstep(0.55, 0.85, ctx.ao) * exposure * 0.6)
    colour = mixRgb(colour, srgbHex(0x8f9068), lichenMask)

    // Dirt darkening in the contacts, applied to albedo as well as AO: real
    // crevices are both shadowed and filled with darker material.
    const crevice = clamp01(1 - ctx.cavity * 1.6)
    colour = mixRgb(colour, { r: colour.r * 0.55, g: colour.g * 0.55, b: colour.b * 0.52 }, crevice * 0.55)

    const roughness = mix(
      mix(0.97, 0.94, silt),
      mix(litho.roughness + 0.08, litho.roughness, wear),
      exposure,
    )

    return {
      albedo: colour,
      roughness: clamp01(roughness - dampness * 0.12 - sparkle * 0.2 + strand * 0.02),
      metalness: 0,
      occlusion: mix(1, 0.86, crevice),
    }
  },
}
