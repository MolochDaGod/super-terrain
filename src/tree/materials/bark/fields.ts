import {
  cellularBorder,
  clamp01,
  hash2,
  mix,
  positiveModulo,
  smooth01,
  tiledFbm,
  tiledValueNoise,
} from '../proceduralNoise'
import { CoarseField } from '../coarseField'
import { sampleColumnarFissures } from './structures/columnarFissures'
import { sampleShallowBlocks } from './structures/shallowBlocks'
import { emptyFlakeSample, FlakeScaleSampler } from './structures/flakeScales'
import { ridgedFurrow } from './structures/ridgedFurrows'
import { sampleScars } from './structures/scars'
import { samplePalmBoots } from './structures/palmBoots'
import { samplePalmRings } from './structures/palmRings'
import { samplePalmFibres } from './structures/palmFibres'
import type { BarkProfile } from './types'

/**
 * The per-texel structure fields the albedo, normal and surface maps are all
 * derived from.
 *
 * Separating this from the colour pass is what makes the two agree. Bark's
 * colour is not decoration laid over its shape — a fissure floor is dark
 * because it is a different, damper, never-weathered tissue, and a plate crown
 * is pale because it has been bleached and colonised by lichen for a decade.
 * Deriving both from one set of fields is the difference between bark and a
 * smooth cylinder with lines drawn on it.
 */
export interface BarkFields {
  width: number
  height: number
  /** Surface relief, 0..1. */
  relief: Float32Array
  /** 1 deep in a fissure, 0 on an open plate face. */
  furrow: Float32Array
  /** How exposed a plate face is: drives bleaching, lichen and polish. */
  exposure: Float32Array
  /** Scale and flake pattern across the plate faces. */
  flake: Float32Array
  /**
   * Which scale this texel belongs to, as a stable 0..1 hash.
   *
   * This is the field the colour pass needs most and the one the old bake had
   * no equivalent of. Photographed bark is a mosaic of individually coloured
   * flakes — ochre next to grey next to olive — and without a per-scale
   * identity the albedo can only be a smooth function of depth, which is
   * exactly the one-paint wash that makes a procedural trunk read as moulded
   * plastic however good its relief is.
   */
  flakeId: Float32Array
  /** How long this scale has been exposed. Independent of `flakeId` on purpose. */
  flakeAge: Float32Array
  /**
   * Contact shadow where a scale is overlapped by a higher neighbour. Only the
   * overlapped side of a lip carries it, which is what makes the surface read
   * as stacked rather than as cracked.
   */
  lip: Float32Array
  /**
   * Healed wound tissue, 1 on the face of an old branch scar. Kept as its own
   * field so the colour pass can make scar tissue the smoother, paler,
   * lichen-free material it actually is rather than painting a ring on.
   */
  scar: Float32Array
  /**
   * Cork grain and its vertical fibre, kept so the colour and roughness passes
   * can read the same fields the relief was built from rather than evaluating
   * identical high-frequency noise a second and third time. Three passes over
   * two megapixels re-deriving the same octaves was a third of the bake.
   */
  grain: Float32Array
  striation: Float32Array
}

/**
 * Vertical cycles for a feature of the given horizontal cycles.
 *
 * The bark tile is square in world space but the texture is twice as tall as it
 * is wide, so a field wanting round features has to run at twice the vertical
 * frequency. Getting this wrong is invisible in the texture — it looks like
 * perfectly ordinary noise — and unmistakable on the trunk, where every feature
 * comes out smeared into a vertical streak. `stretch` is the deliberate
 * elongation a feature actually has: bark grain really does run up the bole.
 */
function down(cyclesU: number, aspect: number, stretch = 1): number {
  return Math.max(1, Math.round((cyclesU * aspect) / stretch))
}

/** Sample count per axis for the crease quantile solve. */
const THRESHOLD_SAMPLES = 128

/** The crease level above which `coverage` of the tile's area falls. */
function solveFurrowThreshold(
  cyclesU: number,
  cyclesV: number,
  seed: number,
  octaves: number,
  width: number,
  coverage: number,
): number {
  const samples = new Float32Array(THRESHOLD_SAMPLES * THRESHOLD_SAMPLES)
  for (let y = 0; y < THRESHOLD_SAMPLES; y += 1) {
    for (let x = 0; x < THRESHOLD_SAMPLES; x += 1) {
      samples[y * THRESHOLD_SAMPLES + x] = ridgedFurrow(
        x / THRESHOLD_SAMPLES, y / THRESHOLD_SAMPLES,
        cyclesU, cyclesV, seed, octaves, width,
      )
    }
  }
  samples.sort()
  const rank = Math.round((1 - clamp01(coverage)) * (samples.length - 1))
  return samples[Math.min(samples.length - 1, Math.max(0, rank))]!
}

export function bakeBarkFields(
  seed: number,
  profile: BarkProfile,
  width: number,
  height: number,
): BarkFields {
  const aspect = height / width
  const pixels = width * height
  const fields: BarkFields = {
    width,
    height,
    relief: new Float32Array(pixels),
    furrow: new Float32Array(pixels),
    exposure: new Float32Array(pixels),
    flake: new Float32Array(pixels),
    flakeId: new Float32Array(pixels),
    flakeAge: new Float32Array(pixels),
    lip: new Float32Array(pixels),
    scar: new Float32Array(pixels),
    grain: new Float32Array(pixels),
    striation: new Float32Array(pixels),
  }
  // Cork granulation and fibre are genuinely sub-millimetre, so the bands that
  // carry them are capped by the texel grid rather than by the material: at
  // 1024 across a 1.6-metre tile there is no point asking for anything finer
  // than about eighty cycles, and asking anyway produces the woven lattice
  // artefact rather than detail. Scaling them with the map means a higher
  // resolution buys actual surface instead of a smooth interpolation of the
  // same surface.
  const detail = width / 1024
  const noise = (u: number, v: number, cyclesU: number, cyclesV: number, key: number) =>
    tiledValueNoise(u * cyclesU, v * cyclesV, key, cyclesU, cyclesV)
  const fbm = (
    u: number, v: number, cyclesU: number, cyclesV: number, key: number, octaves: number,
  ) => tiledFbm(u * cyclesU, v * cyclesV, key, octaves, cyclesU, cyclesV)

  // Everything below ten cycles across the tile is a broad wash whose
  // wavelength is hundreds of texels; sampling those per texel is the bulk of
  // the bake's cost and none of its detail.
  const warpCoarseX = CoarseField.fbm(width, height, 2, down(2, aspect, 1.6), seed + 11, 4, 8)
  const warpFineX = CoarseField.fbm(width, height, 6, down(6, aspect, 1.6), seed + 29, 3, 4)
  const warpCoarseY = CoarseField.fbm(width, height, 2, down(2, aspect), seed + 47, 4, 8)
  const warpFineY = CoarseField.fbm(width, height, 6, down(6, aspect), seed + 59, 3, 4)
  const widthField = CoarseField.fbm(width, height, 5, down(5, aspect, 1.8), seed + 113, 3, 6)
  const linkField = CoarseField.fbm(width, height, 4, down(4, aspect), seed + 149, 3, 6)
  const flakeField = CoarseField.fbm(width, height, 7, down(7, aspect), seed + 167, 3, 5)
  const plateField = CoarseField.fbm(
    width, height, 13, down(13, aspect, 2.4), seed + 173, 4, 3,
  )
  const grainField = CoarseField.fbm(
    width, height, 30, down(30, aspect, 1.5), seed + 211, 4, 2,
  )
  // How vigorously the bark is fissuring, as a broad field over the bole.
  // Without it every plate boundary is cut to the same depth and the network
  // reads as basketwork or corduroy — a regular lattice of identical dark
  // lines. Real bark opens deeply in some regions and barely parts in others,
  // and plates merge into their neighbours wherever it has not.
  const vigourField = CoarseField.fbm(
    width, height, 3, down(3, aspect, 1.7), seed + 331, 4, 8,
  )
  // How far open the fissure is at this point along its own length.
  //
  // Without it a crease network of constant width and constant depth comes out
  // as inked outlines — a jigsaw drawn on the bark rather than cut into it —
  // because the one thing every real crack does is vary: it pinches shut,
  // widens into a gape, and simply stops. This runs several times finer than
  // the vigour wash so the variation happens *within* one fissure rather than
  // between one region and the next.
  const openingField = CoarseField.fbm(
    width, height, 11, down(11, aspect, 2.6), seed + 887, 4, 4,
  )
  const [, linkY] = profile.linkFrequency
  const across = profile.columns
  const [minorX, minorY] = profile.minorFrequency
  // Sized against the plates, not against the texture. At the density a mature
  // oak actually fissures at, running the secondary network at twice the plate
  // frequency makes its cells finer than the plates they are meant to split,
  // and a threshold a couple of texels wide inside those cells comes out as a
  // black hairline rather than as a crack with any width to it.
  const subAcross = Math.max(2, Math.round(across * 1.5))
  const structure = profile.structure ?? 'scaled-plates'
  const columnarStructure = structure === 'columnar-fissures'
  const shallowBlockStructure = structure === 'shallow-blocks'
  const palmBootStructure = structure === 'palm-boots'
  const palmRingStructure = structure === 'palm-rings'
  const palmStructure = palmBootStructure || palmRingStructure
  const scaledPlates = structure === 'scaled-plates'
  const ridgedStructure = structure === 'ridged-furrows'
  const paperyStructure = structure === 'papery-strips'
  const mottledStructure = structure === 'mottled-smooth'
  // Structures that carry their own boundary field and must not be warped as
  // hard as a free-floating cell network.
  const structuredBark = columnarStructure || shallowBlockStructure || palmStructure
  const legacyCells = !structuredBark && !scaledPlates && !ridgedStructure &&
    !paperyStructure && !mottledStructure
  const subField = legacyCells
    ? new CoarseField(width, height, 2, (u, v) => {
      const warp = (tiledValueNoise(u * 2, v * 4, seed + 11, 2, 4) - 0.5) * 0.2
      return cellularBorder(
        (u + warp) * subAcross + 1.9, v * linkY - 4.1, seed + 131,
        subAcross, linkY, 0.66,
      )
    })
    : undefined
  // Only the structures that actually read these pay for them. The scale-based
  // families supply their own fine tier and were evaluating a nine-cell border
  // search, a lenticel octave and two coarse washes per texel purely to
  // multiply the results by zero — about a third of the field pass.
  const legacyFlakes = legacyCells || columnarStructure || shallowBlockStructure ||
    palmStructure
  const flakeBorderField = !legacyFlakes ? undefined : new CoarseField(width, height, 2, (u, v) => {
    const warp = (tiledValueNoise(u * 2, v * 4, seed + 11, 2, 4) - 0.5) * 0.2
    return cellularBorder(
      (u + warp) * minorX + 3.1, v * minorY - 1.7, seed + 109, minorX, minorY, 0.46,
    )
  })

  // --- scale tiers -------------------------------------------------------
  //
  // Cell counts for the overlapping-scale field. A bark surface is legible at
  // three ranges at once and the eye checks all three: the metre-scale plate
  // grouping, the hand-scale scales themselves, and the thumbnail-scale chips
  // shedding off their faces. Supplying only one of the three is what makes a
  // texture read as a pattern rather than as a material, whatever that one
  // tier is doing.
  const scaleAspect = profile.scaleAspect ?? profile.plateAspect
  const scaleColumns = Math.max(2, Math.round(across * (profile.scaleDensity ?? 1.5)))
  const scaleRows = Math.max(2, Math.round((scaleColumns * aspect) / scaleAspect))
  const chipColumns = Math.max(3, Math.round(scaleColumns * 2.7))
  const chipRows = Math.max(3, Math.round((chipColumns * aspect) / Math.max(1, scaleAspect * 0.8)))
  const along0 = Math.max(1, Math.round((across * aspect) / profile.plateAspect))
  const granuleCycles = Math.max(24, Math.round(82 * detail))
  const striationCycles = Math.max(24, Math.round(96 * detail))
  const scaleSample = emptyFlakeSample()
  const chipSample = emptyFlakeSample()
  const scarAmount = profile.scarAmount ?? 0
  // Scars are the lowest-frequency feature in the whole bake — three sites
  // across a 1.6-metre tile — and the most expensive thing evaluated per texel:
  // a nine-cell search with six hashes a cell, for a feature whose smallest
  // detail is a hundred texels across. On the lattice it costs a sixteenth of
  // that and nothing about it is resolvable at full rate anyway.
  const scarRows = Math.max(2, Math.round((3 * aspect) / 1.4))
  const scarTissue = scarAmount > 0
    ? new CoarseField(width, height, 4, (u, v) =>
        sampleScars(u, v, 3, scarRows, seed + 401, scarAmount).tissue)
    : undefined
  const scarRelief = scarAmount > 0
    ? new CoarseField(width, height, 4, (u, v) =>
        sampleScars(u, v, 3, scarRows, seed + 401, scarAmount).relief)
    : undefined
  const scaleLift = profile.scaleLift ?? 0.5
  // The third tier is a chip shedding off the face of a scale, so it only has
  // somewhere to live if the scales are coarse enough to have a face. On a
  // finely scaled bark it lands at the same size as the scales themselves and
  // the two tiers average into gravel.
  const chipStrength = profile.chipAmount ?? 1
  const scaleSampler = palmStructure
    ? undefined
    : new FlakeScaleSampler(
        scaleColumns, scaleRows, seed + 617, scaleLift, scaleLift * 0.55,
      )
  const chipSampler = !palmStructure && !mottledStructure && chipStrength > 0
    ? new FlakeScaleSampler(
        chipColumns, chipRows, seed + 929, scaleLift * 0.42, scaleLift * 0.3,
      )
    : undefined
  // Furrow network frequency for the ridged structures, deliberately below the
  // scale tier: the furrows group the scales, they do not outline them.
  const furrowColumns = Math.max(2, Math.round(across * 0.5))
  const furrowRows = Math.max(1, Math.round((furrowColumns * aspect) / Math.max(1, profile.plateAspect)))
  const creaseColumns = ridgedStructure ? furrowColumns : Math.max(2, across)
  const creaseRows = ridgedStructure ? Math.max(1, furrowRows) : Math.max(1, along0)
  const creaseOctaves = ridgedStructure ? 5 : 4
  // Crease width in cell units. A fibrous bark's furrows are wide troughs; a
  // plated hardwood's are narrow tears between the plates.
  const creaseWidth = profile.furrowWidth ?? (ridgedStructure ? 0.34 : 0.2)
  // Solve the threshold from the field's own distribution instead of authoring
  // it as a raw level.
  //
  // A ridged multifractal's distribution moves with its octave count and its
  // sharpening exponent, so a hand-picked level silently means a different
  // amount of bark every time either is touched — which is how oak came to be
  // forty per cent furrow by area, an unbroken smear of dark cloud rather than
  // a network of cracks, from a number that had looked reasonable when it was
  // written. Sixteen thousand samples is nothing beside two million texels and
  // it makes `furrowCoverage` mean the fraction it claims to.
  const creaseThreshold = solveFurrowThreshold(
    creaseColumns, creaseRows, seed + 733, creaseOctaves, creaseWidth,
    profile.furrowCoverage ?? 0.18,
  )

  for (let y = 0; y < height; y += 1) {
    const v = y / height
    for (let x = 0; x < width; x += 1) {
      const u = x / width
      const index = y * width + x

      // Warp mostly along the columns so a fissure snakes rather than running
      // as a ruled line. Every primitive is periodic, preserving both seams.
      const warpX = structuredBark
        ? (warpCoarseX.at(x, y) - 0.5) * 0.025 + (warpFineX.at(x, y) - 0.5) * 0.018
        : (warpCoarseX.at(x, y) - 0.5) * 0.16 + (warpFineX.at(x, y) - 0.5) * 0.06
      const warpY = (warpCoarseY.at(x, y) - 0.5) * 0.14 + (warpFineY.at(x, y) - 0.5) * 0.04
      const wu = u + warpX
      const wv = v + warpY

      // --- the overlapping scale field, shared by every non-palm structure --
      //
      // Even the smooth barks run it: with the lift near zero and only a
      // handful of cells across the tile it stops being scales and becomes the
      // broad shedding patches a gum or a plane tree actually has, and the
      // colour pass gets a per-patch identity out of the same call.
      let scales: typeof scaleSample | undefined
      if (scaleSampler) {
        scaleSampler.sample(scaleSample, wu, wv)
        scales = scaleSample
      }
      let chips: typeof chipSample | undefined
      if (chipSampler) {
        // Offset, never scaled. Multiplying the uv by 1.7 to decorrelate this
        // tier from the one above it also multiplied its period, so the chip
        // field no longer closed on the tile: every bark using it carried a
        // ruled discontinuity down both seams, which on a trunk is a straight
        // line running the full height of the bole. A constant offset and a
        // different seed decorrelate the two tiers just as well and leave the
        // period alone.
        chipSampler.sample(chipSample, wu + 0.31, wv - 0.17)
        chips = chipSample
      }

      // --- the fissure network ---------------------------------------------
      const along = Math.max(1, Math.round((across * aspect) / profile.plateAspect))
      const columnar = columnarStructure
        ? sampleColumnarFissures(
            wu, wv, across, profile.plateCyclesY, seed, profile.transverseFissureStrength,
          )
        : undefined
      const shallowBlock = shallowBlockStructure
        ? sampleShallowBlocks(
            wu, wv, across, profile.plateCyclesY, seed, profile.transverseFissureStrength,
          )
        : undefined
      const palmBoot = palmBootStructure
        ? samplePalmBoots(wu, wv, across, profile.plateCyclesY, seed)
        : palmRingStructure
          ? samplePalmRings(wu, wv, across, profile.plateCyclesY, seed)
          : undefined
      const structured = columnar ?? shallowBlock ?? palmBoot
      const vigour = clamp01(vigourField.at(x, y) * 1.5 - 0.18)

      let major = 0
      let plateBorder = 0.5
      let subBorder = Number.POSITIVE_INFINITY
      let plateId = scales?.identity ?? 0.5
      let halfWidth = profile.furrowHalfWidth
      if (scaledPlates || ridgedStructure) {
        // A crease field rather than a cell border: it forks, it terminates,
        // and its width varies along its own length, none of which a Voronoi
        // edge can do. See the note in the ridged-furrow module.
        // Four octaves rather than three on the plated barks too. The extra
        // band is what gives a fissure a ragged edge at the texel scale; with
        // three the crease crosses its threshold along a smooth curve and the
        // furrow comes back as an airbrushed smear rather than as a tear.
        const crease = ridgedFurrow(
          wu, wv, creaseColumns, creaseRows, seed + 733,
          creaseOctaves, creaseWidth,
        )
        // A fixed ramp rather than one scaled by the remaining headroom. Tying
        // the wall width to the threshold coupled two things that have nothing
        // to do with each other: asking for sparser fissures also made every
        // one of them softer, so the network faded out instead of thinning.
        const opening = smooth01((openingField.at(x, y) - 0.3) * 2.6)
        major = smooth01((crease - creaseThreshold) / 0.07) *
          mix(0.55, 1.25, vigour) * mix(0.12, 1.15, opening)
        plateBorder = 1 - crease
      } else if (paperyStructure || mottledStructure) {
        major = 0
        plateBorder = 1
      } else {
        halfWidth = profile.furrowHalfWidth *
          (0.6 + plateId * 0.55 + widthField.at(x, y) * 0.6)
        plateBorder = structured?.majorBorder ?? cellularBorder(
          wu * across + 5.7, wv * along - 2.3, seed + 83, across, along, 0.78,
        )
        plateId = structured?.plateIdentity ?? hash2(
          Math.floor(wu * across), Math.floor(wv * along), seed + 97,
        )
        const wall = halfWidth * 1.9
        major = smooth01((wall - plateBorder) / wall) * mix(0.22, 1.1, vigour) *
          (structured?.majorStrength ?? 1)
        subBorder = structured?.crossBreakBorder ?? subField!.at(x, y)
      }

      // --- secondary cracks subdividing the larger plates -------------------
      const linkMask = structured
        ? smooth01((linkField.at(x, y) - 0.43) * 4)
        : smooth01((linkField.at(x, y) - 0.28) * 3.2)
      const linkWall = profile.linkHalfWidth * 1.8
      const link = Number.isFinite(subBorder)
        ? smooth01((linkWall - subBorder) / linkWall) * linkMask
        : 0

      // --- flaking on the plate faces --------------------------------------
      const flake = legacyFlakes
        ? smooth01((0.2 - flakeBorderField!.at(x, y)) / 0.2) *
          smooth01((flakeField.at(x, y) - 0.42) * 4) * (structuredBark ? 0.2 : 1)
        : 0

      const furrow = clamp01(
        major * profile.furrowStrength + link * (structuredBark ? 0.12 : 0.28),
      )
      fields.furrow[index] = furrow
      fields.flake[index] = flake

      // Per-scale identity, and the contact shadow under an overlapping lip.
      // Blending the two scale tiers keeps a chip's own tint from wiping out
      // the scale it sits on: a small chip is a lighter or darker patch *of*
      // its parent scale, not an unrelated colour.
      // On a smooth bark the shed patches have no edge to speak of — the old
      // layer thins away rather than lifting off — so a hard step in identity
      // at every patch boundary draws the polygon outline the structure was
      // chosen to avoid. Feathering it toward the broad wash keeps the mottling
      // and loses the tiling.
      const rawIdentity = scales
        ? clamp01(mix(scales.identity, chips?.identity ?? 0.5, 0.28 * chipStrength))
        : plateId
      fields.flakeId[index] = mottledStructure
        ? mix(rawIdentity, plateField.at(x, y), 0.45)
        : rawIdentity
      fields.flakeAge[index] = scales
        ? clamp01(mix(scales.age, chips?.age ?? 0.5, 0.3 * chipStrength))
        : 0.5
      // A smooth bark's shedding patches have soft, feathered boundaries — the
      // old layer thins out rather than breaking off along an edge — so the
      // contact shadow that makes a scaled bark read as stacked would draw a
      // hard black outline round every patch and turn a beech into camouflage.
      const lipScale = mottledStructure ? 0.12 : paperyStructure ? 0.3 : 1
      fields.lip[index] = scales
        ? clamp01((scales.undercut * 1.5 + (chips?.undercut ?? 0) * 0.8 * chipStrength) * lipScale)
        : 0

      const effectiveMajorBorder = structured
        ? mix(0.5, plateBorder, structured.majorStrength)
        : plateBorder
      const crownBorder = Math.min(effectiveMajorBorder, subBorder)
      const crown = palmStructure
        ? palmBoot!.faceRelief
        : scaledPlates || ridgedStructure || paperyStructure || mottledStructure
          ? 1 - major
          : smooth01(crownBorder / Math.max(1e-3, halfWidth * 2.6)) *
            mix(0.86, 1.06, plateId)

      const plate = plateField.at(x, y)
      const grain = grainField.at(x, y)
      fields.grain[index] = grain
      const lenticel = legacyFlakes || mottledStructure
        ? smooth01((noise(u, v, 96, down(96, aspect), seed + 251) - 0.9) * 10) *
          (1 - furrow)
        : 0

      // The scale families get their finest tier from the chip pass, so this
      // extra nine-cell search only earns its cost on the older structures.
      let fineCrack = 0
      if (legacyFlakes) {
        const fineColumns = Math.max(2, Math.round(across * 3.4))
        const fineRows = Math.max(2, Math.round(along * 3.4))
        const fineBorder = cellularBorder(
          wu * fineColumns + 11.3, wv * fineRows - 6.7, seed + 379,
          fineColumns, fineRows, 0.7,
        )
        fineCrack = smooth01((0.055 - fineBorder) / 0.055) *
          smooth01((fbm(u, v, 6, down(6, aspect), seed + 383, 3) - 0.34) * 3)
      }

      const granule = fbm(u, v, granuleCycles, down(granuleCycles, aspect), seed + 271, 2)
      const palmFibre = palmStructure ? samplePalmFibres(u, v, seed) : undefined
      const striation = palmFibre
        ? clamp01(palmFibre.tone * 0.58 + palmBoot!.faceTone * 0.42)
        : fbm(u, v, striationCycles, down(striationCycles, aspect, 9), seed + 289, 2)
      fields.striation[index] = striation

      // --- papery horizontal peel, for birch --------------------------------
      //
      // Birch is the one bark whose whole identity is transverse. Running it
      // through any of the plate structures produces a cracked-mud sheet that
      // nobody would name as birch, because the structure it needs is not a
      // network at all: it is a stack of horizontal papery bands that lift at
      // their lower edge, plus lenticel dashes drawn straight across them.
      let peel = 0
      let peelEdge = 0
      let lenticelDash = 0
      if (paperyStructure) {
        const bandCycles = Math.max(4, Math.round(profile.plateCyclesY))
        const bandWarp = (fbm(u, v, 5, down(5, aspect, 3), seed + 811, 3) - 0.5) * 0.8
        // The phase offset is not cosmetic. With an integer band count and no
        // offset, a band boundary lands exactly on v = 0 across the whole
        // width, so the one edge in the pattern that cannot wave sits precisely
        // on the tile seam and wraps as a dead straight rule running the full
        // height of the bole. Shifting the phase moves every boundary off it.
        const bandPosition = wv * bandCycles + 0.37 + bandWarp
        const bandStart = Math.floor(bandPosition)
        // Wrapped, or the band the tile ends on and the band it starts on draw
        // different hashes and the strip pattern steps at the horizontal seam.
        const bandIndex = positiveModulo(bandStart, bandCycles)
        const withinBand = bandPosition - bandStart
        const bandHeight = hash2(0, bandIndex, seed + 823)
        peel = bandHeight
        // The lifted lower lip of each strip: a hard step, not a groove.
        peelEdge = smooth01((0.13 - withinBand) / 0.13) *
          smooth01((hash2(1, bandIndex, seed + 827) - 0.25) * 3)
        // Lenticels: short dark dashes running across the grain, sparse and
        // strongly elongated in x. They are most of what a viewer identifies
        // birch by after the colour.
        const dash = noise(u, v, 26, down(26, aspect, 7), seed + 839)
        lenticelDash = smooth01((dash - 0.74) * 7)
      }

      const scarTissueValue = scarTissue ? scarTissue.at(x, y) : 0
      const scarReliefValue = scarRelief ? scarRelief.at(x, y) : 0
      fields.scar[index] = scarTissueValue

      // Scales ride on the surface between the fissures, and a fissure that is
      // itself full of scales is not a fissure — it is a seam of gravel. This
      // one multiply is what restores the hierarchy the crease field is meant
      // to impose: the network groups the scales rather than competing with
      // them, and the trunk reads as fissured from across a clearing again
      // instead of as an even rubble of chips at every distance.
      const openBark = 1 - furrow
      const scaleRelief = (scales?.height ?? 0) * mix(0.25, 1, openBark)
      const chipRelief = (chips?.height ?? 0) * chipStrength * openBark

      fields.relief[index] = clamp01(palmStructure
        ? 0.2 + crown * 0.08 + plate * 0.07 + grain * 0.08 +
          granule * 0.09 + (palmFibre?.relief ?? striation) * 0.48 -
          flake * 0.012 - fineCrack * 0.02 -
          furrow * profile.furrowDepth
        : mottledStructure
        // A smooth bark is not flat, and it is not featureless either.
        //
        // The first version of this line read "any crisp relief at all reads as
        // damage" and weighted the fine tiers at 0.02-0.035, which combined
        // with a zero `scaleLift` produced a normal map whose mean deviation
        // from flat was 0.8 of 128 — a map that may as well not have been
        // baked. What that reasoning missed is that the *broad* structure it
        // wanted is exactly the part a normal map cannot deliver: a swell a
        // handspan across is carried by the mesh. What is left for the map is
        // precisely the fine stuff — cork granulation, vertical striation and
        // lenticel scars — and on a bark with no fissures to look at, that
        // fine tier is the entire surface.
        //
        // Still well under the fissured recipes: no furrow term, and the
        // scale tier stays where it is so the polygon mosaic does not return.
        ? 0.45 + scaleRelief * 0.16 + plate * 0.08 + grain * 0.15 +
          granule * 0.13 + striation * 0.17 + lenticel * 0.1
        : paperyStructure
        ? 0.44 + peel * 0.05 + peelEdge * 0.16 + grain * 0.05 +
          granule * 0.04 + lenticelDash * 0.05 + scarReliefValue * 0.18 -
          furrow * profile.furrowDepth
        : ridgedStructure
        // Fibrous bark: the furrows carry nearly all the relief and the faces
        // between them are covered in vertical fibre rather than in scales.
        ? 0.34 + scaleRelief * 0.14 + chipRelief * 0.07 + striation * 0.16 +
          grain * 0.1 + granule * 0.07 + plate * 0.05 -
          furrow * profile.furrowDepth + scarReliefValue * 0.2
        : scaledPlates
        // The scale tiers carry the relief and the furrows group them. This is
        // the reverse of the old weighting, where a crack network carried
        // everything and the faces between were left smooth.
        ? 0.3 + scaleRelief * 0.26 + chipRelief * 0.12 + grain * 0.14 +
          granule * 0.11 + striation * 0.07 + plate * 0.05 -
          furrow * profile.furrowDepth + scarReliefValue * 0.22
        : shallowBlockStructure
        ? 0.3 + crown * 0.3 + scaleRelief * 0.08 + plate * 0.045 + grain * 0.075 +
          granule * 0.065 + striation * 0.04 + lenticel * 0.025 -
          flake * 0.018 - fineCrack * 0.02 -
          furrow * profile.furrowDepth + scarReliefValue * 0.2
        : columnarStructure
        // Oak plates are themselves made of scales. Adding the scale tier here
        // is what stops a plate face between two fissures reading as a sanded
        // board with a wood-grain print on it.
        ? 0.28 + crown * 0.16 + scaleRelief * 0.16 + chipRelief * 0.07 +
          plate * 0.09 + grain * 0.12 +
          granule * 0.1 + striation * 0.08 + lenticel * 0.03 -
          flake * 0.025 - fineCrack * 0.05 -
          furrow * profile.furrowDepth + scarReliefValue * 0.28
        : 0.24 + crown * 0.42 + plate * 0.2 + grain * 0.1 + scarReliefValue * 0.28 -
          fineCrack * 0.05 +
          granule * 0.06 + striation * 0.05 + lenticel * 0.055 - flake * 0.09 -
          furrow * profile.furrowDepth)

      // Exposure is what has been facing the weather: the crowns of the plates,
      // never the insides of the cracks.
      fields.exposure[index] = palmStructure
        ? clamp01(0.25 + crown * 0.14 + (palmFibre?.tone ?? 0.5) * 0.2 - furrow * 0.22)
        : scaledPlates || ridgedStructure
        // A raised scale is the part that has been in the weather; the ones it
        // overlaps are sheltered. Reading exposure off the scale relief rather
        // than off distance-to-a-crack is what lets the colour pass bleach the
        // proud flakes and leave the sunk ones raw.
        // Raised to a power so the fissure's shoulder does not bleach into a
        // soft dark cloud spreading over the plates either side. A linear
        // `1 - furrow` paints the entire ramp, and since the ramp is much
        // wider than the crack, the trunk comes back covered in smudges that
        // read as stains rather than as openings in the bark.
        ? clamp01((1 - Math.pow(furrow, 1.9)) * (0.18 + scaleRelief * 0.92) -
          fields.lip[index]! * 0.4)
        : paperyStructure
        ? clamp01(0.7 + peel * 0.3 - peelEdge * 0.7 - lenticelDash * 0.6)
        : mottledStructure
        // Gently: on a smooth bark this is the difference between one shed
        // patch and the next, not between a lit crown and the floor of a
        // fissure, and saturating it posterises the trunk into flat regions.
        ? clamp01(0.15 + scaleRelief * 0.75)
        : clamp01(crown * (1 - furrow) - flake * 0.35)
    }
  }
  return fields
}

/**
 * Tangent-space normals from the relief field, wrapping at both seams.
 *
 * `strength` converts relief units into a real slope, so it has to be sized
 * against the texel spacing rather than picked by eye — and it has a ceiling as
 * well as a floor. Too low and the height field holds a perfectly good fissure
 * network while the normal map reports a flat sheet. Too high and the fissure
 * walls encode past eighty degrees, which is a surface pointing almost directly
 * away from every light in the scene: the trough stops reading as a trough and
 * comes back as a hard black line, which is the same artefact arrived at from
 * the opposite end. A wall somewhere near fifty degrees keeps a lit side.
 */
export function barkRelief(
  fields: BarkFields,
  target: Uint8Array,
  strength: number,
): void {
  const { width, height, relief } = fields
  for (let y = 0; y < height; y += 1) {
    const previousY = y === 0 ? height - 1 : y - 1
    const nextY = y + 1 === height ? 0 : y + 1
    const row = y * width
    const previousRow = previousY * width
    const nextRow = nextY * width
    for (let x = 0; x < width; x += 1) {
      const previousX = x === 0 ? width - 1 : x - 1
      const nextX = x + 1 === width ? 0 : x + 1
      const dx = (relief[row + nextX]! - relief[row + previousX]!) * strength
      const dy = (relief[nextRow + x]! - relief[previousRow + x]!) * strength
      const inverse = 1 / Math.sqrt(dx * dx + dy * dy + 1)
      const offset = (row + x) * 4
      target[offset] = toByte(-dx * inverse * 0.5 + 0.5)
      target[offset + 1] = toByte(-dy * inverse * 0.5 + 0.5)
      target[offset + 2] = toByte(inverse * 0.5 + 0.5)
      target[offset + 3] = 255
    }
  }
}

function toByte(value: number): number {
  return Math.round(clamp01(value) * 255)
}

export { mix }
