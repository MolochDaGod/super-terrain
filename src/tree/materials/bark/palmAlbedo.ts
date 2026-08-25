import { byte, clamp01, mix, smooth01 } from '../proceduralNoise'
import { CoarseField } from '../coarseField'
import type { BarkFields } from './fields'
import type { BarkPalette } from './types'

/**
 * Colour for the arid, fibrous surface of a palm stipe.
 *
 * Hardwood colour logic assumes pale exposed plate crowns above damp dark
 * fissures. A palm is accumulated vascular fibre and severed petiole bases;
 * sending it through that pass collapses the whole surface into muddy brown.
 * This packer keeps the same shared relief fields but interprets them as old
 * cut faces, torn fibre beds and newly exposed straw-coloured tissue.
 */
export function packPalmBarkAlbedo(
  fields: BarkFields,
  palette: BarkPalette,
  target: Uint8Array,
  seed: number,
): void {
  const { width, height } = fields
  const aspect = height / width
  const broad = CoarseField.fbm(width, height, 3, Math.round(6 / aspect), seed + 701, 4, 8)
  const abrasion = CoarseField.fbm(width, height, 11, 18, seed + 719, 3, 4)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const exposure = fields.exposure[index]!
      const furrow = fields.furrow[index]!
      const fibre = fields.striation[index]!
      const grain = fields.grain[index]!
      const weather = broad.at(x, y) - 0.5
      const worn = abrasion.at(x, y)

      const cutFace = smooth01((exposure - 0.39) * 4.8)
      // Old Phoenix scars are mostly the same grey-brown as the surrounding
      // fibre. Making every boot face a pale tile turns the stipe into a
      // stamped reptile pattern, even when the relief is anatomically right.
      const faceWear = clamp01(
        0.16 + cutFace * (0.12 + weather * 0.055) + (grain - 0.5) * 0.05,
      )
      let red = mix(palette.fissure[0], palette.crown[0], faceWear)
      let green = mix(palette.fissure[1], palette.crown[1], faceWear)
      let blue = mix(palette.fissure[2], palette.crown[2], faceWear)

      const tornFibre = smooth01((fibre + worn * 0.22 - 0.59) * 4.6) *
        smooth01((cutFace - 0.08) * 2.2) * (1 - furrow)
      red = mix(red, palette.fresh[0], tornFibre * 0.24)
      green = mix(green, palette.fresh[1], tornFibre * 0.2)
      blue = mix(blue, palette.fresh[2], tornFibre * 0.15)

      const tone = 1 + (grain - 0.5) * 0.16 + (fibre - 0.5) * 0.14 + weather * 0.12
      red *= tone
      green *= tone
      blue *= tone

      const recess = furrow * (0.07 + worn * 0.05)
      red = mix(red, palette.fissure[0] * 0.78, recess)
      green = mix(green, palette.fissure[1] * 0.78, recess)
      blue = mix(blue, palette.fissure[2] * 0.78, recess)

      const offset = index * 4
      target[offset] = byte(red)
      target[offset + 1] = byte(green)
      target[offset + 2] = byte(blue)
      target[offset + 3] = 255
    }
  }
}
