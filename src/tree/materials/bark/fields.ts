import {
  cellularBorder,
  clamp01,
  hash2,
  mix,
  smooth01,
  tiledFbm,
  tiledValueNoise,
} from '../proceduralNoise'
import { CoarseField } from '../coarseField'
import { sampleColumnarFissures } from './structures/columnarFissures'
import { sampleShallowBlocks } from './structures/shallowBlocks'
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
    scar: new Float32Array(pixels),
    grain: new Float32Array(pixels),
    striation: new Float32Array(pixels),
  }
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
  // How vigorously the bark is fissuring, as a broad field over the bole.
  // Without it every plate boundary is cut to the same depth and the network
  // reads as basketwork or corduroy — a regular lattice of identical dark
  // lines. Real bark opens deeply in some regions and barely parts in others,
  // and plates merge into their neighbours wherever it has not.
  const vigourField = CoarseField.fbm(
    width, height, 3, down(3, aspect, 1.7), seed + 331, 4, 8,
  )
  // The two subordinate crack networks at half resolution. A cell-border field
  // resampled this way softens its crack by about a texel, which matters for
  // the plate network that carries the whole read and does not for these two:
  // one splits a plate and the other is shallow scale relief. Each was a
  // nine-cell search with two hashes per cell, and between them they were a
  // third of the field pass.
  const [, linkY] = profile.linkFrequency
  const across = profile.columns
  const [minorX, minorY] = profile.minorFrequency
  // Sized against the plates, not against the texture. At the density a mature
  // oak actually fissures at, running the secondary network at twice the plate
  // frequency makes its cells finer than the plates they are meant to split,
  // and a threshold a couple of texels wide inside those cells comes out as a
  // black hairline rather than as a crack with any width to it.
  const subAcross = Math.max(2, Math.round(across * 1.5))
  const structuredBark = profile.structure === 'columnar-fissures' ||
    profile.structure === 'shallow-blocks' || profile.structure === 'palm-boots' ||
    profile.structure === 'palm-rings'
  const subField = structuredBark
    ? undefined
    : new CoarseField(width, height, 2, (u, v) => {
      const warp = (tiledValueNoise(u * 2, v * 4, seed + 11, 2, 4) - 0.5) * 0.2
      return cellularBorder(
        (u + warp) * subAcross + 1.9, v * linkY - 4.1, seed + 131,
        subAcross, linkY, 0.66,
      )
    })
  const flakeBorderField = new CoarseField(width, height, 2, (u, v) => {
    const warp = (tiledValueNoise(u * 2, v * 4, seed + 11, 2, 4) - 0.5) * 0.2
    return cellularBorder(
      (u + warp) * minorX + 3.1, v * minorY - 1.7, seed + 109, minorX, minorY, 0.46,
    )
  })

  for (let y = 0; y < height; y += 1) {
    const v = y / height
    for (let x = 0; x < width; x += 1) {
      const u = x / width
      const index = y * width + x

      // Warp mostly along the columns so a fissure snakes rather than running
      // as a ruled line. Every primitive is periodic, preserving both seams.
      const columnarStructure = profile.structure === 'columnar-fissures'
      const shallowBlockStructure = profile.structure === 'shallow-blocks'
      const palmBootStructure = profile.structure === 'palm-boots'
      const palmRingStructure = profile.structure === 'palm-rings'
      const palmStructure = palmBootStructure || palmRingStructure
      const warpX = structuredBark
        ? (warpCoarseX.at(x, y) - 0.5) * 0.025 + (warpFineX.at(x, y) - 0.5) * 0.018
        : (warpCoarseX.at(x, y) - 0.5) * 0.26 + (warpFineX.at(x, y) - 0.5) * 0.085
      const warpY = (warpCoarseY.at(x, y) - 0.5) * 0.14 + (warpFineY.at(x, y) - 0.5) * 0.04
      const wu = u + warpX
      const wv = v + warpY

      // --- the plate network, which is the whole read of mature bark -------
      //
      // Bark plates are *closed blocks*, and the fissures are the gaps all the
      // way around each one. Building the network from a one-dimensional cell
      // field in x cannot express that: every fissure it produces is a single
      // continuous curve running the entire height of the bole, so the trunk
      // comes out as a bundle of unbroken vertical ribbons and no amount of
      // cross-cutting laid on afterwards convincingly breaks them.
      //
      // A jittered cell network does express it, and the vertical bias oak
      // actually has comes for free from running the two axes at different
      // frequencies: a plate a hand wide and three hands tall is just a cell
      // that is square in the sampled space and stretched in the world.
      const along = Math.max(1, Math.round((across * aspect) / profile.plateAspect))
      const columnar = profile.structure === 'columnar-fissures'
        ? sampleColumnarFissures(
            wu,
            wv,
            across,
            profile.plateCyclesY,
            seed,
            profile.transverseFissureStrength,
          )
        : undefined
      const shallowBlock = shallowBlockStructure
        ? sampleShallowBlocks(
            wu,
            wv,
            across,
            profile.plateCyclesY,
            seed,
            profile.transverseFissureStrength,
          )
        : undefined
      const palmBoot = palmBootStructure
        ? samplePalmBoots(wu, wv, across, profile.plateCyclesY, seed)
        : palmRingStructure
          ? samplePalmRings(wu, wv, across, profile.plateCyclesY, seed)
          : undefined
      const structured = columnar ?? shallowBlock ?? palmBoot
      const plateBorder = structured?.majorBorder ?? cellularBorder(
        wu * across + 5.7, wv * along - 2.3, seed + 83, across, along, 0.78,
      )
      // Per-plate identity, so no two plates weather or sit at quite the same
      // height. Quantising the warped position is enough — the network's own
      // cells are within a texel or two of these bounds.
      const plateId = structured?.plateIdentity ?? hash2(
        Math.floor(wu * across), Math.floor(wv * along), seed + 97,
      )
      const halfWidth = profile.furrowHalfWidth *
        (0.6 + plateId * 0.55 + widthField.at(x, y) * 0.6)
      // A rounded floor rather than a step: `smooth01` of the signed distance
      // gives a fissure that opens gradually into the plates either side, which
      // is what a shrinkage crack in a growing cork layer actually looks like.
      // Widen the ramp well past the crack itself. A fissure whose depth turns
      // on over a texel or two is a black line; a real one is an open trough
      // with two lit walls falling into it, and the walls are most of what the
      // eye uses to read the bark as deep rather than drawn.
      const vigour = clamp01(vigourField.at(x, y) * 1.5 - 0.18)
      // The wall, not the crack, is what the eye reads as depth. Ramping the
      // depth over roughly the crack's own width gives a near-vertical wall a
      // couple of texels across, which lights as a single black line with no
      // lit side at all — the ink-stripe look, arrived at from the opposite
      // direction. Opening the ramp to nearly twice the half-width turns it
      // into a trough with two walls the sun can actually catch.
      const wall = halfWidth * 1.9
      const major = smooth01((wall - plateBorder) / wall) * mix(0.22, 1.1, vigour) *
        (structured?.majorStrength ?? 1)

      // --- secondary cracks subdividing the larger plates -------------------
      const subBorder = structured?.crossBreakBorder ?? subField!.at(x, y)
      const linkMask = structured
        ? smooth01((linkField.at(x, y) - 0.43) * 4)
        : smooth01((linkField.at(x, y) - 0.28) * 3.2)
      // Shallower than the plate fissures, which is the correct hierarchy: a
      // secondary crack splits a plate, it does not open another gap.
      const linkWall = profile.linkHalfWidth * 1.8
      const link = smooth01((linkWall - subBorder) / linkWall) * linkMask

      // --- flaking on the plate faces --------------------------------------
      //
      // Not cracks. Mature bark sheds in scales, and the shallow steps between
      // them are what stops a plate face reading as a smooth panel. Kept
      // shallow on purpose: at fissure depth they compete with the fissures and
      // the surface turns to gravel.
      const flakeBorder = flakeBorderField.at(x, y)
      const flakeMask = smooth01((flakeField.at(x, y) - 0.42) * 4)
      // Same reasoning as the secondary cracks: a scale edge has to be a step
      // several texels wide, or it is another hairline.
      const flake = smooth01((0.2 - flakeBorder) / 0.2) * flakeMask *
        (structuredBark ? 0.2 : 1)

      // Secondary cracks contribute far less depth than the plate fissures. At
      // parity they cut a sharp, deep line a few texels wide across every plate
      // face, and a field of those is the ink-drawn look returning by the back
      // door — the hierarchy between a gap and a split has to be visible.
      const furrow = clamp01(
        major * profile.furrowStrength + link * (structuredBark ? 0.12 : 0.28),
      )
      fields.furrow[index] = furrow
      fields.flake[index] = flake

      // The plate itself: a broad crown that falls away toward every fissure,
      // carrying its own coarse and fine roughness.
      // The plate domes across most of its own width rather than reaching full
      // height a few texels in and then running dead flat. A flat-topped plate
      // has no gradient anywhere on it, which is why the faces were reading as
      // sanded plywood with a wood-grain print on them.
      const effectiveMajorBorder = structured
        ? mix(0.5, plateBorder, structured.majorStrength)
        : plateBorder
      const crownBorder = Math.min(effectiveMajorBorder, subBorder)
      const crown = palmStructure
        ? palmBoot!.faceRelief
        : smooth01(crownBorder / Math.max(1e-3, halfWidth * 2.6)) *
          mix(0.86, 1.06, plateId)
      // Plate form and grain both run up the bole, so they keep a deliberate
      // vertical stretch; the pores and the micro grain do not, so they get the
      // full aspect correction.
      const plate = plateField.at(x, y)
      const grain = fbm(u, v, 34, down(34, aspect, 1.5), seed + 211, 4)
      fields.grain[index] = grain
      // Raised cork pores, only where the surface is not already broken. These
      // were running at a quarter of the vertical frequency they needed and
      // came out as short vertical dashes rather than as pores.
      // Sparse on mature fissured bark: lenticels are a young-bark feature and
      // a field of them reads as tick marks scattered over the plates.
      const lenticel = smooth01(
        (noise(u, v, 96, down(96, aspect), seed + 251) - 0.9) * 10,
      ) * (1 - furrow)

      // Cork granulation at the scale of a texel or two. Without it the plate
      // faces come back with a normal pointing straight out over almost their
      // whole area, which is what makes bark render as a smooth turned
      // cylinder no matter how good the fissure network above it is.
      // A sharp, shallow crack tier between the fissures and the grain.
      //
      // Bark is rough at every scale at once, and a surface carrying only one
      // feature size reads as moulded however deep that feature is. The
      // fissures ramp over eight or nine texels because a trough needs walls;
      // this tier deliberately does the opposite — a texel or two wide and
      // barely deep — so the close-range surface has something crisp on it
      // without adding another set of dark lines.
      const fineBorder = cellularBorder(
        wu * across * 3.4 + 11.3, wv * along * 3.4 - 6.7, seed + 379,
        Math.max(2, Math.round(across * 3.4)), Math.max(2, Math.round(along * 3.4)), 0.7,
      )
      const fineCrack = smooth01((0.055 - fineBorder) / 0.055) *
        smooth01((fbm(u, v, 6, down(6, aspect), seed + 383, 3) - 0.34) * 3)

      const granule = fbm(u, v, 300, down(300, aspect), seed + 271, 2)
      // Cork splits along the grain, so a plate face is covered in fine
      // vertical striation. It is the one feature that genuinely wants a
      // strong vertical stretch, and its absence is why plate faces read as
      // smooth leather rather than as something fibrous and woody.
      const palmFibre = palmStructure ? samplePalmFibres(u, v, seed) : undefined
      const striation = palmFibre
        ? clamp01(palmFibre.tone * 0.58 + palmBoot!.faceTone * 0.42)
        :
        fbm(u, v, 190, down(190, aspect, 9), seed + 289, 2)
      fields.striation[index] = striation

      // Old branch sockets. A handful of large features that break the
      // vertical grain and give the bole a history; see the scar module.
      const scar = sampleScars(
        wu, wv, 3, Math.max(2, Math.round((3 * aspect) / 1.4)), seed + 401,
        profile.scarAmount ?? 0,
      )
      fields.scar[index] = scar.tissue

      fields.relief[index] = clamp01(palmStructure
        // Lower date-palm boots are healed, split fibre and shallow scar lips,
        // not inflated cushions. The upper retained bases are represented by
        // actual crown geometry; the material supplies the aged lower scars.
        ? 0.2 + crown * 0.08 + plate * 0.07 + grain * 0.08 +
          granule * 0.09 + (palmFibre?.relief ?? striation) * 0.48 -
          flake * 0.012 - fineCrack * 0.02 -
          furrow * profile.furrowDepth
        : shallowBlockStructure
        // Live-oak-style shallow blocks need a crisp meso-scale silhouette and
        // restrained grain. If fine fbm carries more relief than the block
        // shoulders, the result is blurry camouflage instead of cork plates.
        ? 0.3 + crown * 0.3 + plate * 0.045 + grain * 0.075 +
          granule * 0.065 + striation * 0.04 + lenticel * 0.025 -
          flake * 0.018 - fineCrack * 0.02 -
          furrow * profile.furrowDepth + scar.relief * 0.2
        : columnarStructure
        // Hardwood cork is rough across the plate face as well as inside its
        // fissures. Keeping granular bands stronger than the shallow furrow
        // prevents a close normal map from becoming a set of routed slots.
        ? 0.28 + crown * 0.18 + plate * 0.12 + grain * 0.15 +
          granule * 0.12 + striation * 0.1 + lenticel * 0.04 -
          flake * 0.025 - fineCrack * 0.055 -
          furrow * profile.furrowDepth + scar.relief * 0.28
        // Amplitudes are chosen against the slope each band actually produces,
        // not by eye: an fbm returns a 0..1 field whose usable swing is about
        // half its range, so a band's contribution to the normal is roughly
        // amplitude x pi / wavelength-in-texels x the strength above. The fine
        // bands need far more amplitude than they look like they should.
        : 0.24 + crown * 0.42 + plate * 0.2 + grain * 0.1 + scar.relief * 0.28 -
          fineCrack * 0.05 +
          granule * 0.06 + striation * 0.05 + lenticel * 0.055 - flake * 0.09 -
          furrow * profile.furrowDepth)
      // Exposure is what has been facing the weather: the crowns of the plates,
      // never the insides of the cracks.
      fields.exposure[index] = palmStructure
        // A healed boot is not a pale tile pasted over the fibre bed. Most of
        // its contrast comes from roughness and edge relief; only freshly worn
        // faces lift slightly in colour.
        ? clamp01(0.25 + crown * 0.14 + (palmFibre?.tone ?? 0.5) * 0.2 - furrow * 0.22)
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
    const previousY = (y - 1 + height) % height
    const nextY = (y + 1) % height
    for (let x = 0; x < width; x += 1) {
      const previousX = (x - 1 + width) % width
      const nextX = (x + 1) % width
      const dx = (relief[y * width + nextX]! - relief[y * width + previousX]!) * strength
      const dy = (relief[nextY * width + x]! - relief[previousY * width + x]!) * strength
      const inverse = 1 / Math.hypot(dx, dy, 1)
      const offset = (y * width + x) * 4
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
