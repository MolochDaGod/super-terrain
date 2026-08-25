import { byte, clamp01, hash2, mix, smooth01 } from '../proceduralNoise'
import { CoarseField } from '../coarseField'
import type { BarkFields } from './fields'
import type { BarkPalette, BarkProfile } from './types'

/**
 * Bark colour, derived from the same structure fields as the relief.
 *
 * The single biggest reason a procedural trunk reads as turned timber is an
 * albedo that knows nothing about its own fissures: a nearly uniform brown
 * wash, with every crack living only in the normal map. Lit, that gives a
 * smooth cylinder with hairlines scratched into it, because a normal map can
 * only redirect light — it cannot make one part of the surface a darker
 * material than another.
 *
 * Real bark has an enormous albedo range built into its anatomy. A fissure
 * floor is young, damp, unweathered tissue that has never been bleached and
 * sits permanently in shade; a plate crown has been sun-bleached, dried and
 * colonised by crustose lichen for years. Between the two is close to a
 * factor of eight in reflectance, and putting that in albedo is most of what
 * separates bark from wood.
 */
export function packBarkAlbedo(
  fields: BarkFields,
  palette: BarkPalette,
  profile: BarkProfile,
  target: Uint8Array,
  seed: number,
): void {
  const { width, height } = fields
  // The tile is square in world space while the texture is twice as tall, so
  // every field here needs its vertical frequency doubled or it renders as a
  // vertical smear on the trunk. See the note on `down` in the field pass.
  const aspect = height / width
  const down = (cyclesU: number, stretch = 1) =>
    Math.max(1, Math.round((cyclesU * aspect) / stretch))
  const resinous = profile.family === 'resinous-conifer'
  // The weathering, moisture, lichen and moss washes are all broad fields; see
  // the note on CoarseField for why they are not sampled per texel.
  const broadField = CoarseField.fbm(width, height, 2, down(2, 1.5), seed + 137, 4, 8)
  const mesoField = CoarseField.fbm(width, height, 9, down(9, 1.4), seed + 307, 3, 4)
  const moistureField = CoarseField.fbm(width, height, 3, down(3, 2.2), seed + 151, 4, 8)
  const lichenPatch = CoarseField.fbm(width, height, 4, down(4), seed + 191, 3, 6)
  const speckleField = CoarseField.fbm(width, height, 18, down(18), seed + 197, 3, 3)
  const mossPatch = CoarseField.fbm(width, height, 3, down(3, 1.8), seed + 179, 4, 8)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const furrow = fields.furrow[index]!
      const scar = fields.scar[index]!
      const exposure = fields.exposure[index]!
      const flake = fields.flake[index]!
      const flakeId = fields.flakeId[index]!
      const flakeAge = fields.flakeAge[index]!
      const lip = fields.lip[index]!

      // Weathering at three scales. The broad field is what stops one trunk
      // reading as one paint; the mid field gives the patchiness a decade of
      // uneven wetting leaves; the fine field is cork grain.
      const broad = broadField.at(x, y) - 0.5
      const meso = mesoField.at(x, y) - 0.5
      // Read from the structure pass, so the colour and the relief describe
      // the same fibres rather than two independent fields that happen to look
      // similar — and so the octaves are evaluated once, not three times.
      const grain = fields.grain[index]! - 0.5
      const striation = fields.striation[index]! - 0.5
      // Rain runs downward, so moisture is the one field that earns a strong
      // vertical stretch rather than having it corrected away.
      const moisture = moistureField.at(x, y)

      // Weathered crown versus raw fissure. `exposure` already excludes the
      // insides of the cracks, so this one mix carries the whole range.
      // Gentler than the relief. Bark colour does not switch from crown to
      // fissure at the lip of the crack — the weathering fades down the wall,
      // so a hard albedo step there reads as a line drawn along the bottom.
      // The broad washes are held well below the anatomy they sit on. At half
      // amplitude they swing the surface across most of its own tonal range,
      // and since they run at two and nine cycles across the whole tile the
      // result is soft dark continents drifting over the bark with every trace
      // of scale detail dissolved inside them — read as damp stains or as a
      // badly lit render, never as bark. They are a modulation, not a layer.
      const rawWeathering = clamp01(Math.pow(exposure, 0.72) * 1.05 +
        broad * 0.26 + meso * 0.18)
      // Some barks differ radically in relief but only subtly in colour. Live
      // oak is the important case: copying the full depth field into albedo
      // turns every shallow shrinkage fissure into a painted black symbol.
      // Pull only that anatomical component toward the mid-tone while keeping
      // broad wetting and weathering variation intact.
      const fissureColour = profile.fissureColorStrength ?? 1
      const weathering = mix(0.5, rawWeathering, fissureColour)
      let red = mix(palette.fissure[0], palette.crown[0], weathering)
      let green = mix(palette.fissure[1], palette.crown[1], weathering)
      let blue = mix(palette.fissure[2], palette.crown[2], weathering)

      // --- the per-scale colour mosaic --------------------------------------
      //
      // This is the single largest difference between a photograph of bark and
      // everything above it. Every term so far is a smooth function of depth or
      // of a broad wash, so the whole trunk comes out as one pigment shaded
      // light and dark — which is what a turned and stained cylinder looks
      // like, and is what it read as. In a photograph, two scales sharing an
      // edge routinely differ by a third in value and visibly in hue: ochre
      // beside pink-grey beside olive. The variation is *per scale*, it is
      // discontinuous at the scale boundary, and it is uncorrelated with how
      // deep that scale happens to sit.
      //
      // So it has to come from the scale's own identity rather than from any
      // field the relief also reads. Two independent hashes per scale: what
      // tint its cork is, and how long it has been in the weather.
      const mosaic = profile.mosaicAmount ?? 1
      const tint = (flakeId - 0.5) * 2
      // A young scale still has the warm, saturated colour of fresh cork; an
      // old one has bleached toward the grey crown. Because `flakeAge` is a
      // separate hash from `flakeId`, a pale scale is not automatically the
      // warm one, and the mosaic stops reading as a single colour ramp.
      const aged = smooth01((flakeAge - 0.32) * 1.7)
      const scaleR = mix(palette.fresh[0], palette.crown[0], aged)
      const scaleG = mix(palette.fresh[1], palette.crown[1], aged)
      const scaleB = mix(palette.fresh[2], palette.crown[2], aged)
      // Weighted by exposure: this is the colour of a scale face, and it must
      // not paint over the raw tissue at the bottom of a fissure.
      const faceWeight = mosaic * 0.6 * clamp01(exposure * 1.3);
      red = mix(red, scaleR, faceWeight)
      green = mix(green, scaleG, faceWeight)
      blue = mix(blue, scaleB, faceWeight)
      // Per-scale value and hue. The hue swing matters as much as the value
      // one: bark chroma is low, but which direction that low chroma points
      // changes from scale to scale, and value jitter alone still reads as a
      // greyscale pattern with a tint applied afterwards.
      const value = 1 + tint * 0.22 * mosaic * clamp01(exposure * 1.5)
      // Deliberately about a quarter of the value swing. Bark hue does vary
      // from scale to scale, but only within a narrow warm band; matching the
      // two made neighbouring scales read as blue-grey against orange, which
      // is lichen crust or camouflage rather than cork.
      const warm = tint * 0.055 * mosaic
      red *= value * (1 + warm)
      green *= value * (1 + warm * 0.25)
      blue *= value * (1 - warm)

      // A freshly shed scale exposes lighter, warmer cork underneath. It has
      // to be *lighter* than the weathered crown: a darker target turns every
      // scale border into a fine dark stroke, and a field of fine dark strokes
      // is the ink-drawn look this whole pass exists to remove.
      const fresh = smooth01((flake - 0.4) * 2.2)
      red = mix(red, palette.fresh[0], fresh * 0.55)
      green = mix(green, palette.fresh[1], fresh * 0.55)
      blue = mix(blue, palette.fresh[2], fresh * 0.55)

      // Cork grain, applied multiplicatively so it stays proportional to how
      // light the surface already is. Added flat, it washes the dark fissures
      // out and leaves the crowns untouched.
      // Cork is a coarse, crumbly material. Understated grain here is what
      // leaves the plate faces looking like polished leather stretched over
      // the trunk rather than like something that flakes off in the hand.
      const grainAmount = profile.grainAmount ?? 1
      const tone = 1 + (grain * 0.38 + striation * 0.24 + meso * 0.16) * grainAmount
      red *= tone
      green *= tone
      blue *= tone

      // Rain runs down the fissures and keeps them dark long after the plate
      // faces have dried.
      // Damp belongs in the fissures. Letting a quarter of it onto the open
      // plates put a second soft continent-scale stain over the first.
      const damp = smooth01((moisture - 0.48) * 3) * mix(0.06, 1, furrow)
      const wetness = damp * (resinous ? 0.16 : 0.3) * fissureColour
      red = mix(red, palette.fissure[0] * 0.86, wetness)
      green = mix(green, palette.fissure[1] * 0.86, wetness)
      blue = mix(blue, palette.fissure[2] * 0.86, wetness)

      // Crustose lichen colonises the open, dry, well-lit crowns and stops
      // dead at the fissure edge — one of the most recognisable things about
      // a mature trunk, and free structure the eye reads instantly.
      const lichenField = lichenPatch.at(x, y)
      const speckle = speckleField.at(x, y)
      // Two thresholds multiplied together are a very sparse event; loosening
      // both is what makes the colonies actually appear on the trunk rather
      // than once every few tiles.
      const lichen = smooth01((lichenField - 0.44) * 3.4) *
        smooth01((speckle - 0.36) * 3.8) *
        exposure * (resinous ? 0.35 : 0.8) * (profile.lichenAmount ?? 1) *
        // Wound wood is young: crustose lichen takes decades to take hold on
        // it, so a scar stays conspicuously clean in the middle of a colonised
        // trunk. That contrast is most of what makes the scar read as healed
        // rather than as a stain painted on.
        (1 - scar * 0.9)
      const lichenTone = 1 + speckle * 0.3 - 0.15
      red = mix(red, palette.lichen[0] * lichenTone, lichen)
      green = mix(green, palette.lichen[1] * lichenTone, lichen)
      blue = mix(blue, palette.lichen[2] * lichenTone, lichen)

      // Moss takes the damp side and the shelter of the fissures instead.
      const mossField = mossPatch.at(x, y)
      const moss = smooth01((mossField + moisture * 0.3 - 0.82) * 3.6) *
        mix(0.45, 1, furrow) * (resinous ? 0.2 : 0.5) * (profile.mossAmount ?? 1)
      red = mix(red, palette.moss[0], moss)
      green = mix(green, palette.moss[1], moss)
      blue = mix(blue, palette.moss[2], moss)

      // Healed wound wood: paler, greyer and smoother than the bark around it.
      if (scar > 0) {
        red = mix(red, 0.47, scar * 0.62)
        green = mix(green, 0.445, scar * 0.62)
        blue = mix(blue, 0.4, scar * 0.62)
      }

      // The overlapped side of a lip. A real occlusion rather than decoration:
      // a scale lying under its neighbour carries a hard shadow along the
      // shared edge and the one on top carries none, and that asymmetry is
      // most of what makes a surface read as stacked rather than as cracked.
      // A symmetric groove — which is all a crack network can draw — has it on
      // both sides and therefore reads as neither.
      const shade = 1 - lip * 0.3
      // Texel-scale grit, uncorrelated with everything above on purpose. Cork
      // is granular right down to the resolution limit; a map that is
      // perfectly smooth between its features renders as wet plastic however
      // good the low frequencies are.
      const grit = shade * (1 + (hash2(x, y, seed + 6151) - 0.5) * 0.1)
      red *= grit
      green *= grit
      blue *= grit

      const offset = index * 4
      target[offset] = byte(red)
      target[offset + 1] = byte(green)
      target[offset + 2] = byte(blue)
      target[offset + 3] = 255
    }
  }
}

/**
 * Roughness, into the green and blue of the ORM map.
 *
 * Weathered crowns polish smoother than damp, dusty fissure floors, and lichen
 * is chalkier than either.
 */
export function packBarkRoughness(fields: BarkFields, target: Uint8Array): void {
  const { width, height } = fields
  for (let index = 0; index < width * height; index += 1) {
    // Roughness varies per scale for the same reason albedo does. A single
    // roughness for the whole trunk gives every face an identical sheen, and a
    // uniform sheen is one of the strongest cues that a surface was generated
    // rather than photographed: real scales differ in how far each has
    // weathered down from resinous and slightly glossy to chalky and matte.
    const rough = clamp01(
      0.9 - fields.exposure[index]! * 0.16 - fields.scar[index]! * 0.22 +
        fields.furrow[index]! * 0.05 +
        (fields.flakeAge[index]! - 0.5) * 0.14 +
        (fields.grain[index]! - 0.5) * 0.12 +
        (fields.striation[index]! - 0.5) * 0.06,
    )
    const offset = index * 4
    const value = byte(rough)
    // Red is filled by the ambient-occlusion pass once relief is complete.
    target[offset + 1] = value
    target[offset + 2] = value
    target[offset + 3] = 255
  }
}
