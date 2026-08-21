import type { SurfaceRecipe } from '../bake'
import { blurField, createField, type Field, fillField, stretchField } from '../field'
import { bilateralSmooth, thermalErosion } from '../erosion'
import { clamp01, fbm, hashInt, mix, ridged, smoothstep } from '../noise'
import { beddingField, jointSets, laminaeField, pittedSurface, speckleField } from '../common'
import { runoffStain, siltDeposit, upFacing } from '../weathering'
import { mixRgb, srgbHex, type Rgb } from '../encode'

/**
 * Ember fault rock — a near-black slate wall along a mineralised fault.
 *
 * Slate's character is its fissility: a cleavage far finer than any bedding,
 * which makes the face split into thin plates and terminate in hundreds of
 * hairline steps. Along a fault the rock is additionally brecciated and
 * hydrothermally altered, so iron oxide is precipitated into the fracture
 * network. That gives the material its two scales — an almost graphite-flat
 * groundmass, and the warm seams threading through it.
 *
 * The cleavage is keyed to the block mosaic rather than laid over it: plates
 * terminate where their block does, which is what makes the wall read as
 * broken slabs of a layered rock instead of a corrugated sheet.
 */

const SLATE_DARK = srgbHex(0x25272a)
const SLATE_MID = srgbHex(0x3c3f41)
const SLATE_PALE = srgbHex(0x6a6c69)
const QUARTZ = srgbHex(0x928d83)
const OXIDE_DEEP = srgbHex(0x5c3620)
const OXIDE_BRIGHT = srgbHex(0x8a5a30)
const SOOT = srgbHex(0x131415)

export const emberFaultRockRecipe: SurfaceRecipe = {
  id: 'ember-fault-rock',
  physicalWidth: 2,
  reliefDepth: 0.11,

  build(size, seed) {
    const s = size / 1024
    const packetCount = 11

    // Cleavage packets: the scale at which the wall actually splits. Their
    // thicknesses are drawn from a distribution rather than fixed — evenly
    // spaced packets turn the mosaic into brickwork.
    const packets = beddingField(size, packetCount, seed + 9, {
      wander: 0.022,
      wanderPeriod: 3,
      dip: 0.02,
    })
    // Packet coordinate in tile units, so the brecciated blocks are bounded
    // by cleavage surfaces the way real slate breaks.
    const packetCoord = createField(size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x
        packetCoord.data[i] = (packets.index.data[i]! + packets.phase.data[i]!) / packetCount
      }
    }

    // Cleavage-parallel partings, the fault-parallel shears that offset
    // them, and a sparse cross set. Sampling in the packet coordinate keeps
    // every fracture terminating against a cleavage surface.
    const mosaic = jointSets(
      size,
      [
        {
          nx: 0,
          ny: 1,
          count: packetCount,
          presence: 0.9,
          amplitude: 0.36,
          tilt: 0.25,
          wander: 0.014,
          wanderPeriod: 3,
          continuity: 0.95,
          aperture: 1.4,
        },
        {
          nx: 1,
          ny: 0,
          count: 5,
          presence: 0.6,
          amplitude: 0.24,
          tilt: 0.35,
          wander: 0.05,
          wanderPeriod: 4,
          continuity: 0.5,
          aperture: 1.1,
        },
        {
          nx: 1,
          ny: 2,
          count: 7,
          presence: 0.3,
          amplitude: 0.05,
          tilt: 0.3,
          wander: 0.06,
          wanderPeriod: 5,
          continuity: 0.3,
          aperture: 0.6,
        },
      ],
      seed + 29,
      packetCoord,
    )

    // The fine fissility within each packet, offset and re-spaced per block.
    // Lamination that runs unbroken across a fracture is the giveaway that it
    // was laid over the surface rather than displaced with the rock: a block
    // that has moved carries its layering with it.
    const fine = laminaeField(size, 120, seed + 5, {
      wander: 1,
      sharpness: 0.09,
      dip: 0.015,
      offset: mosaic.blockId,
      spacing: mosaic.domainId,
    })

    // Slate weathers by plucking flakes rather than by dissolving, so the
    // pits are shallow, wide and elongated along the cleavage.
    const pits = pittedSurface(size, seed + 619, [
      { cells: 24, depth: 0.03, density: 0.16, aspect: 2.4 },
      { cells: 58, depth: 0.02, density: 0.24, aspect: 2.2 },
      { cells: 145, depth: 0.013, density: 0.34, aspect: 1.8 },
      { cells: 330, depth: 0.008, density: 0.45, aspect: 1.5 },
      { cells: 740, depth: 0.005, density: 0.55 },
    ])

    const base = createField(size)
    const spall = createField(size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x
        const u = x / size
        const v = y / size
        let h = mosaic.height.data[i]!
        h -= mosaic.carve.data[i]! * 0.3

        // Cleavage relief, scaled per block: a plate that split recently
        // shows every lamina, one that has weathered for decades shows few.
        const block = mosaic.blockId.data[i]!
        const fresh = 0.3 + block * 1.5
        h -= (1 - fine.step.data[i]!) * 0.026 * fresh
        const partingPhase = packets.phase.data[i]!
        h -= (smoothstep(0.1, 0, partingPhase) + smoothstep(0.9, 1, partingPhase)) * 0.045

        // Blocks that have shed a plate entirely, leaving an angular scar.
        const spalled = block > 0.78 ? 1 : 0
        const spallMask = spalled * smoothstep(0.02, 0.15, mosaic.interior.data[i]!)
        spall.data[i] = spallMask
        h -= spallMask * 0.055

        // Groundmass grain, and the fretted texture inside spalled hollows.
        h += fbm(u * 140, v * 220, 140, seed + 13, { octaves: 3, stretchY: 1.6 }) * 0.008
        h += ridged(u * 38, v * 80, 38, seed + 17, { octaves: 4, stretchY: 2 }) * 0.014 * (0.25 + spallMask)
        h += pits.data[i]! * (0.55 + fresh * 0.35) * (1 + spallMask * 0.7)

        base.data[i] = h
      }
    }

    const settled = thermalErosion(base, { iterations: 6, talusAngle: 0.05 / s, rate: 0.4 })
    const faceted = bilateralSmooth(settled, Math.max(1, 1.2 * s), 0.014, 1)
    const height = stretchField(faceted, 0.004, 0.996)

    const speckle = speckleField(size, seed + 401)

    // Seep points: the sparse places along the fracture network where
    // iron-bearing water actually reaches the face. The stain itself is grown
    // downhill from these in the weathering stage, because oxide that sits
    // evenly inside every crack reads as paint following a mask.
    const seepSource = fillField(size, (u, v) => {
      const i = Math.min(size - 1, Math.floor(v * size)) * size +
        Math.min(size - 1, Math.floor(u * size))
      const along = mosaic.carve.data[i]! * 0.9 + (1 - mosaic.interior.data[i]!) * 0.5
      // Only a few points along the network are actually seeping; a stain
      // issuing from every crack at once reads as a painted mask.
      const active = clamp01(fbm(u * 6, v * 6, 6, seed + 151, { octaves: 4 }) * 1.6 + 0.5)
      return clamp01(along * active * 2.2 - 0.75) * 0.08
    })

    return {
      height,
      normalBoost: 1.15,
      ao: { radius: Math.max(12, size / 22), intensity: 1.15 },
      data: {
        fine: fine.step,
        fineIndex: fine.index,
        packets: packets.phase,
        interior: mosaic.interior,
        block: mosaic.blockId,
        domain: mosaic.domainId,
        spall,
        speckle,
        seepSource,
      } satisfies Record<string, Field>,
    }
  },

  derive({ height, ao, data }, seed) {
    const s = height.size / 1024
    // Iron oxide bleeds down and outward from each seep, pooling on the
    // ledges below it and fading as it goes.
    const oxide = stretchField(
      blurField(
        runoffStain(data.seepSource!, {
          decay: 0.985,
          wander: height.size / 40,
          seed: seed + 311,
        }),
        Math.max(1, 2.5 * s),
        2,
      ),
      0.2,
      0.99,
    )
    const dust = stretchField(
      siltDeposit(height, ao, { scale: 30, smooth: Math.max(1, 2 * s) }),
      0.3,
      0.99,
    )
    const streak = stretchField(
      runoffStain(upFacing(height, 24), {
        decay: 0.987,
        wander: height.size / 80,
        seed: seed + 173,
      }),
      0.3,
      0.99,
    )
    return { dust, streak, oxide }
  },

  shade(ctx) {
    const i = ctx.index
    const fine = ctx.data.fine!.data[i]!
    const fineIndex = ctx.data.fineIndex!.data[i]!
    const packets = ctx.data.packets!.data[i]!
    const interior = ctx.data.interior!.data[i]!
    const block = ctx.data.block!.data[i]!
    const domain = ctx.data.domain!.data[i]!
    const spall = ctx.data.spall!.data[i]!
    const speckle = ctx.data.speckle!.data[i]!
    const oxide = ctx.data.oxide!.data[i]!
    const dust = ctx.data.dust!.data[i]!
    const streak = ctx.data.streak!.data[i]!

    // Groundmass: near-black, with per-block tonal variation. Slate is dark
    // enough that most of its visible structure comes from small reflectance
    // differences between adjacent plates, not from hue.
    const blockTone = mix(0.72, 1.4, block) * mix(0.9, 1.1, domain)
    let colour: Rgb = {
      r: SLATE_DARK.r * blockTone,
      g: SLATE_DARK.g * blockTone,
      b: SLATE_DARK.b * blockTone,
    }

    // A minority of laminae are silty and noticeably paler.
    const laminaHash = (hashInt(Math.round(fineIndex)) >>> 5) & 0xff
    if (laminaHash < 46) colour = mixRgb(colour, SLATE_MID, mix(0.2, 0.65, laminaHash / 46))
    // The exposed top edge of each plate catches light and wear.
    colour = mixRgb(
      colour,
      SLATE_PALE,
      clamp01(1 - fine) * 0.2 + smoothstep(0.22, 0.02, packets) * 0.18,
    )

    // Freshly split faces are cleaner and cooler than the patinated wall.
    colour = mixRgb(colour, { r: colour.r * 1.45, g: colour.g * 1.48, b: colour.b * 1.46 }, spall * 0.35)

    // Iron oxide from the fault fluids: deep rust in the seams, brighter
    // where it has bled onto the wall and dried.
    const seam = clamp01(oxide * 1.05 - 0.28)
    colour = mixRgb(colour, OXIDE_DEEP, seam * 0.55)
    colour = mixRgb(colour, OXIDE_BRIGHT, clamp01(seam - 0.65) * 1.8 * 0.3)

    // Quartz and pyrite picked out along the same fractures.
    const sparkle = speckle > 0.985 ? (speckle - 0.985) * 62 : 0
    colour = mixRgb(colour, QUARTZ, sparkle * clamp01(0.25 + seam) * 0.75)

    // Rock flour on the up-facing plate ledges, washed down below them.
    colour = mixRgb(colour, srgbHex(0x7c766b), clamp01(dust * 1.15 - 0.25) * 0.24)
    colour = mixRgb(colour, SOOT, clamp01(streak * 0.9 - 0.35) * 0.3)

    // Fractures and cleavage partings are packed with dark fines.
    // Darkening follows the cavity the fracture actually cut, not its trace.
    const fissure = clamp01((1 - ctx.cavity * 1.8) * 1.15 + (1 - interior) * 0.2)
    colour = mixRgb(colour, SOOT, fissure * 0.5)

    const grain = (speckle - 0.5) * 0.08
    colour = { r: colour.r * (1 + grain), g: colour.g * (1 + grain), b: colour.b * (1 + grain) }

    // Slate keeps a faint sheen on its cleavage planes; the altered and
    // fretted areas are dead matt.
    const roughness = clamp01(
      mix(0.58, 0.92, clamp01(seam * 0.85 + spall * 0.5)) -
        sparkle * 0.3 +
        fissure * 0.1 +
        clamp01(1 - fine) * 0.06,
    )

    return {
      albedo: colour,
      roughness,
      // A trace of metalness on the sulphide-rich seams: enough to make them
      // shift with the light, not enough to read as metal.
      metalness: clamp01(sparkle * 0.6 * clamp01(seam * 1.5)),
      occlusion: mix(1, 0.62, fissure),
    }
  },
}
