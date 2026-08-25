import { byte, clamp01, mix } from '../proceduralNoise'
import { CoarseField } from '../coarseField'
import type { BarkFields } from './fields'
import type { BarkPalette } from './types'

/** Grey-tan coconut fibre crossed by broken annular leaf-scar lips. */
export function packPalmRingAlbedo(
  fields: BarkFields,
  palette: BarkPalette,
  target: Uint8Array,
  seed: number,
): void {
  const { width, height } = fields
  const broad = CoarseField.fbm(width, height, 4, 9, seed + 811, 4, 6)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const furrow = fields.furrow[index]!
      const fibre = fields.striation[index]!
      const grain = fields.grain[index]!
      const weather = broad.at(x, y) - 0.5
      const baseMix = clamp01(0.48 + weather * 0.28 + (grain - 0.5) * 0.12)
      let red = mix(palette.fissure[0], palette.crown[0], baseMix)
      let green = mix(palette.fissure[1], palette.crown[1], baseMix)
      let blue = mix(palette.fissure[2], palette.crown[2], baseMix)
      const fibreTone = 0.86 + fibre * 0.28
      red *= fibreTone
      green *= fibreTone
      blue *= 0.9 + fibre * 0.2
      const recess = clamp01(furrow * 0.72)
      red = mix(red, palette.fissure[0] * 0.58, recess)
      green = mix(green, palette.fissure[1] * 0.58, recess)
      blue = mix(blue, palette.fissure[2] * 0.55, recess)
      const offset = index * 4
      target[offset] = byte(red)
      target[offset + 1] = byte(green)
      target[offset + 2] = byte(blue)
      target[offset + 3] = 255
    }
  }
}
