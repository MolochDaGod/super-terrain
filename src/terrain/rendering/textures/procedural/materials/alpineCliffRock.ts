import type { SurfaceRecipe } from '../bake'
import { blurField, createField, type Field, fillField, stretchField } from '../field'
import { bilateralSmooth, thermalErosion } from '../erosion'
import { clamp01, fbm, hashInt, mix, ridged, smoothstep, worley } from '../noise'
import { jointSets, lichenField, pittedSurface, speckleField } from '../common'
import { flowAccumulation, runoffStain, siltDeposit, upFacing } from '../weathering'
import { mixRgb, srgbHex } from '../encode'

/**
 * Foliated alpine bedrock — a dark, folded schist/gneiss face.
 *
 * The defining structure is a penetrative fabric: metamorphism aligned the
 * platy minerals into surfaces that were then folded, and competent lenses
 * (augen and boudins) survived within the flowing fabric while the softer
 * micaceous layers weathered back around them.
 *
 * Everything here is sampled in one folded fabric coordinate — the laminae,
 * the lenses, the block mosaic, the veins. That is the whole trick: when the
 * structures share a coordinate they wrap around the folds together, the way
 * a real deformed rock does, and the surface reads as something that was
 * folded rather than as several patterns stacked on one another.
 */

const MICA_DARK = srgbHex(0x30332f)
const MICA_MID = srgbHex(0x4a4f4a)
const FELSIC = srgbHex(0x878a80)
const QUARTZ_VEIN = srgbHex(0xa8a79b)
const CHLORITE = srgbHex(0x3e463c)
const WET = srgbHex(0x1e201c)
const LICHEN_CRUST = srgbHex(0x8e8248)

export const alpineCliffRockRecipe: SurfaceRecipe = {
  id: 'alpine-cliff-rock',
  physicalWidth: 2.4,
  reliefDepth: 0.14,

  build(size, seed) {
    const s = size / 1024

    // Folding, expressed as a displacement of the fabric coordinate. Applying
    // it to the coordinate rather than to the finished height keeps every
    // structure that reads the coordinate in register with every other.
    const fold = fillField(size, (u, v) => {
      const long = fbm(u * 2.5, v * 2.5, 3, seed + 3, { octaves: 3, stretchX: 2.6 })
      const medium = fbm(u * 7, v * 7, 7, seed + 11, { octaves: 4, stretchX: 3.6 })
      const fine = fbm(u * 19, v * 19, 19, seed + 19, { octaves: 3, stretchX: 4.2 })
      return long * 0.6 + medium * 0.28 + fine * 0.1
    })

    const fabric = createField(size)
    const foliation = createField(size)
    const competence = createField(size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x
        const u = x / size
        const f = (y / size) + fold.data[i]! * 0.26
        fabric.data[i] = f
        // Alternating micaceous and quartzofeldspathic laminae, with an
        // asymmetric profile so each parting has a sharp lip and a soft back.
        const t = f * 26
        const phase = t - Math.floor(t)
        foliation.data[i] = smoothstep(0, 0.18, phase) * smoothstep(1, 0.7, phase)
        competence.data[i] = clamp01(
          0.5 +
            fbm(u * 4, f * 14, 4, seed + 31, { octaves: 3, stretchX: 2.2 }) * 0.55 +
            Math.sin(Math.floor(t) * 2.399) * 0.2,
        )
      }
    }

    // Joint sets in the fabric coordinate: one running along the foliation,
    // a conjugate pair cutting it at high angle. Sampling in fabric space is
    // what makes the fractures step along the folds rather than craze across
    // them.
    const mosaic = jointSets(
      size,
      [
        {
          nx: 0,
          ny: 1,
          count: 10,
          presence: 0.8,
          amplitude: 0.34,
          tilt: 0.3,
          wander: 0.02,
          wanderPeriod: 3,
          continuity: 0.85,
          aperture: 1.3,
        },
        {
          nx: 1,
          ny: 0,
          count: 4,
          presence: 0.7,
          amplitude: 0.3,
          tilt: 0.4,
          wander: 0.055,
          wanderPeriod: 4,
          continuity: 0.5,
          aperture: 1.2,
        },
        {
          nx: 1,
          ny: 1,
          count: 6,
          presence: 0.3,
          amplitude: 0.07,
          tilt: 0.3,
          wander: 0.06,
          wanderPeriod: 5,
          continuity: 0.3,
          aperture: 0.7,
        },
      ],
      seed + 71,
      fabric,
    )

    const augen = createField(size)
    const augenId = createField(size)
    const flake = createField(size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x
        const u = x / size
        const f = fabric.data[i]!

        // Augen: competent lenses stretched along the fabric.
        const w = worley(u * 4, f * 4, 4, seed + 53, 0.95, 3.2)
        if (((hashInt(w.id) >>> 7) & 0xff) / 255 < 0.62) {
          const radius = mix(0.3, 0.7, ((hashInt(w.id + 1) >>> 3) & 0xff) / 255)
          const edge = fbm(u * 16, f * 16, 16, seed + 59, { octaves: 4, stretchX: 2 }) * 0.16
          const lens = smoothstep(radius, radius * 0.2, w.f1 + edge)
          if (lens > augen.data[i]!) {
            augen.data[i] = lens
            augenId.data[i] = (hashInt(w.id + 7) & 0xffff) / 65536
          }
        }

        // Plates shed along the foliation, leaving stepped scars.
        const p = worley(u * 15, f * 15, 15, seed + 97, 1, 2.6)
        if (((hashInt(p.id + 3) >>> 9) & 0xff) / 255 < 0.4) {
          const edge = fbm(u * 26, f * 26, 26, seed + 101, { octaves: 4, stretchX: 2.2 }) * 0.18
          flake.data[i] = smoothstep(0.5, 0.12, p.f1 + edge)
        }
      }
    }

    // Grain-scale damage: plucked mica plates, weathering pits and the
    // conchoidal chips left where the rock has spalled.
    const pits = pittedSurface(size, seed + 613, [
      { cells: 26, depth: 0.05, density: 0.2, aspect: 1.8 },
      { cells: 60, depth: 0.03, density: 0.3, aspect: 1.6 },
      { cells: 150, depth: 0.018, density: 0.4, aspect: 1.4 },
      { cells: 340, depth: 0.01, density: 0.5 },
      { cells: 760, depth: 0.006, density: 0.55 },
    ])

    const base = createField(size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x
        const u = x / size
        const f = fabric.data[i]!
        let h = mosaic.height.data[i]! * 1.1
        h -= mosaic.carve.data[i]! * 0.24

        // Differential weathering along the fabric. How much of the fabric
        // is still legible depends on how long the block has been exposed,
        // so it is modulated per block: a face that keeps its corrugation
        // everywhere reads as bark rather than as rock.
        const fresh = 0.25 + mosaic.blockId.data[i]! * 1.4
        h += (competence.data[i]! - 0.5) * 0.22 * fresh
        h -= foliation.data[i]! * 0.055 * fresh

        // Competent lenses stand proud with a rounded crown.
        h += augen.data[i]! * 0.24

        // Fabric-parallel striation at grain scale: the fine, hair-like
        // corrugation that makes schist unmistakable in raking light. Kept
        // shallow — turned up, it becomes a wood grain.
        h += ridged(u * 44, f * 96, 44, seed + 37, { octaves: 4, stretchX: 4.5 }) * 0.013 * fresh
        h += fbm(u * 150, f * 260, 150, seed + 41, { octaves: 3, stretchX: 3 }) * 0.008

        // Flake scars step the surface back by a plate thickness.
        h -= flake.data[i]! * 0.055
        h += pits.data[i]! * (0.6 + fresh * 0.4)

        base.data[i] = h
      }
    }

    // Bevel the fracture edges, then flatten the facets between them without
    // rounding the edges back off.
    // Barely enough creep to knock the corners off. More relaxes every block
    // step into a lit ramp, which traces each block in a bright outline.
    const weathered = thermalErosion(base, { iterations: 6, talusAngle: 0.05 / s, rate: 0.4 })
    const faceted = bilateralSmooth(weathered, Math.max(1, 1.3 * s), 0.015, 1)
    const height = stretchField(faceted, 0.004, 0.996)

    const speckle = speckleField(size, seed + 707)
    const lichen = lichenField(size, seed + 811, {
      colonies: Math.round(150 * s * s),
      minRadius: size / 130,
      maxRadius: size / 13,
      ragged: 0.8,
    })
    const vein = fillField(size, (u, v) => {
      const i = Math.min(size - 1, Math.floor(v * size)) * size + Math.min(size - 1, Math.floor(u * size))
      return ridged(u * 8, fabric.data[i]! * 8, 8, seed + 131, { octaves: 4, stretchX: 3.5 })
    })

    return {
      height,
      normalBoost: 1.1,
      ao: { radius: Math.max(12, size / 20), intensity: 1.15 },
      data: {
        fabric,
        foliation,
        competence,
        augen,
        augenId,
        flake,
        interior: mosaic.interior,
        block: mosaic.blockId,
        speckle,
        lichen,
        vein,
      } satisfies Record<string, Field>,
    }
  },

  derive({ height, ao }, seed) {
    const s = height.size / 1024
    const dust = stretchField(
      siltDeposit(height, ao, { scale: 26, smooth: Math.max(1, 2 * s) }),
      0.25,
      0.99,
    )
    const streak = stretchField(
      runoffStain(upFacing(height, 22), {
        decay: 0.984,
        wander: height.size / 60,
        seed: seed + 137,
      }),
      0.3,
      0.99,
    )
    const drainage = stretchField(
      blurField(flowAccumulation(height), Math.max(1, 1.5 * s)),
      0.5,
      0.998,
    )
    return { dust, streak, drainage }
  },

  shade(ctx) {
    const i = ctx.index
    const foliation = ctx.data.foliation!.data[i]!
    const competence = ctx.data.competence!.data[i]!
    const augen = ctx.data.augen!.data[i]!
    const augenId = ctx.data.augenId!.data[i]!
    const flake = ctx.data.flake!.data[i]!
    const interior = ctx.data.interior!.data[i]!
    const block = ctx.data.block!.data[i]!
    const speckle = ctx.data.speckle!.data[i]!
    const lichen = ctx.data.lichen!.data[i]!
    const vein = ctx.data.vein!.data[i]!
    const dust = ctx.data.dust!.data[i]!
    const streak = ctx.data.streak!.data[i]!
    const drainage = ctx.data.drainage!.data[i]!

    // Mineral banding: mica-rich laminae dark and slightly green, the
    // quartzofeldspathic ones pale grey.
    let colour = mixRgb(MICA_DARK, FELSIC, clamp01(competence * 1.2 - 0.2))
    colour = mixRgb(colour, MICA_MID, foliation * 0.4)
    colour = mixRgb(colour, CHLORITE, clamp01(0.5 - competence) * 0.55)
    // Blocks weather at their own rate, so each carries its own patina.
    const blockTone = mix(0.72, 1.3, block)
    colour = { r: colour.r * blockTone, g: colour.g * blockTone, b: colour.b * blockTone * 0.98 }

    // Competent lenses are paler and each carries its own tint.
    const lensTint = mix(0.88, 1.18, augenId)
    colour = mixRgb(
      colour,
      { r: FELSIC.r * lensTint, g: FELSIC.g * lensTint * 0.98, b: FELSIC.b * lensTint * 0.94 },
      augen * 0.5,
    )

    // Quartz veins run along the fabric and are the brightest thing on the
    // face; they are thin, so the mask is deliberately steep.
    const veinMask = smoothstep(0.74, 0.94, vein) * smoothstep(0.3, 0.65, competence)
    colour = mixRgb(colour, QUARTZ_VEIN, veinMask * 0.6)

    // Freshly spalled plates expose unweathered rock: cleaner and brighter
    // than the surrounding patina.
    colour = mixRgb(colour, { r: colour.r * 1.4, g: colour.g * 1.38, b: colour.b * 1.34 }, flake * 0.4)

    // Mica sparkle: a sharp, sparse luminance spike paired with a roughness
    // drop, which is how a specular glint actually behaves.
    const flakes = speckle > 0.978 ? (speckle - 0.978) * 46 : 0
    colour = mixRgb(colour, srgbHex(0xc6c9c3), flakes * 0.5)

    // Water lingers in the partings, the drainage lines and the joints. A wet
    // dark schist is most of the reference's character.
    const damp = clamp01(streak * 0.5 + drainage * 0.45 + (1 - ctx.ao) * 0.55 + foliation * 0.2)
    colour = mixRgb(colour, WET, clamp01(damp * 0.6))
    // Darkening follows the cavity the fracture actually cut, not its trace.
    const fissure = clamp01((1 - ctx.cavity * 1.8) * 1.15 + (1 - interior) * 0.2)
    colour = mixRgb(colour, WET, fissure * 0.45)

    // Rock flour on the up-facing ledges.
    colour = mixRgb(colour, srgbHex(0x7d7a70), clamp01(dust * 1.1 - 0.2) * 0.3)

    // Crustose lichen: ochre-yellow on the exposed, convex, dry ground.
    const exposure = smoothstep(0.55, 0.9, ctx.ao) * smoothstep(-0.2, 0.3, ctx.curvature)
    const lichenMask = clamp01(lichen * exposure * (1 - fissure))
    colour = mixRgb(colour, LICHEN_CRUST, lichenMask * 0.55)
    // A second, rarer grey-green species keeps the colonies from reading as
    // one stamped pattern.
    colour = mixRgb(colour, srgbHex(0x77836b), clamp01(lichen - 0.72) * 1.8 * exposure * 0.45)

    const grain = (speckle - 0.5) * 0.07
    colour = { r: colour.r * (1 + grain), g: colour.g * (1 + grain), b: colour.b * (1 + grain * 0.9) }

    const roughness = clamp01(
      mix(0.84, 0.62, competence) -
        flakes * 0.35 -
        damp * 0.2 -
        veinMask * 0.12 +
        lichenMask * 0.25 +
        flake * 0.05,
    )

    return {
      albedo: colour,
      roughness,
      metalness: 0,
      occlusion: mix(1, 0.64, fissure),
    }
  },
}
