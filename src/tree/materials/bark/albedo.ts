import { byte, clamp01, mix, smooth01 } from '../proceduralNoise'
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
      const rawWeathering = clamp01(Math.pow(exposure, 0.72) * 1.05 +
        broad * 0.5 + meso * 0.3)
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
      const damp = smooth01((moisture - 0.48) * 3) * mix(0.25, 1, furrow)
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
    const rough = clamp01(
      0.94 - fields.exposure[index]! * 0.18 - fields.scar[index]! * 0.22 +
        fields.furrow[index]! * 0.05 +
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
