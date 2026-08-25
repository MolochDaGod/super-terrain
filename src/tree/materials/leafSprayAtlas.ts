import { clamp01 } from './proceduralNoise'
import type { TreeSpecies } from '../generator/types'
import { makeBladeShape } from './leaf/blade'
import { dilateFields } from './leaf/dilate'
import { layoutSpray } from './leaf/layout'
import { packNormals } from './leaf/normal'
import { bakeCardOcclusion } from './leaf/occlusion'
import { leafBaseColour } from './leaf/pigment'
import { leafProfileFor } from './leaf/profiles'
import { drawLeaf, drawShoots } from './leaf/raster'
import { createSprayFields } from './leaf/types'

export type { LeafSprayMaps } from './leaf/types'
export { leafProfileFor } from './leaf/profiles'

import type { LeafSprayMaps } from './leaf/types'

/** Texels the dilation pushes each channel out past the cutout rim. */
const DILATION_PASSES = 8

/**
 * Bakes one leaf *spray*: a twiglet carrying a dozen or more leaves, composed
 * into a single card texture.
 *
 * A card is only worth drawing if what it holds could not be afforded as
 * geometry, so the leaves are laid out the way the species actually arranges
 * them — English oak leaves are near-sessile, alternate, crowded toward the
 * shoot tip, and cluster into rosettes rather than spacing evenly along the
 * stem. Getting that arrangement right is most of what separates a card that
 * reads as foliage from one that reads as a decal.
 */
export function bakeLeafSpray(
  seed: number,
  species: TreeSpecies,
  variant: number,
  size: number,
): LeafSprayMaps {
  const profile = leafProfileFor(species)
  const fields = createSprayFields(size)
  const { leaves, shoots } = layoutSpray(seed + variant * 7717, variant, profile)
  drawShoots(shoots, fields)
  for (const leaf of leaves) drawLeaf(leaf, profile, fields)

  // Occlusion is measured before dilation, while the coverage field still has
  // its true silhouette; dilating first would inflate the spray and lift the
  // rim's occlusion toward the interior value.
  const occlusion = bakeCardOcclusion(fields)

  const { alpha } = fields
  dilateFields([
    { values: fields.tint, stride: 3 },
    { values: fields.height, stride: 1 },
    { values: fields.surfaceRoughness, stride: 1 },
    { values: fields.translucency, stride: 1 },
    { values: occlusion, stride: 1 },
    // The blade planes need dilating for the same reason every other channel
    // does: an undilated rim texel holds a zero normal, which mips into a
    // sideways-facing fringe around every cutout.
    { values: fields.basis, stride: 3 },
  ], alpha, size, DILATION_PASSES)

  const pixels = size * size
  const albedo = new Uint8Array(pixels * 4)
  const roughness = new Uint8Array(pixels * 4)
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4
    const byteAlpha = Math.round(clamp01(alpha[index]!) * 255)
    albedo[offset] = toByte(fields.tint[index * 3]!)
    albedo[offset + 1] = toByte(fields.tint[index * 3 + 1]!)
    albedo[offset + 2] = toByte(fields.tint[index * 3 + 2]!)
    albedo[offset + 3] = byteAlpha
    // Material properties, not height-derived shadow. The blade rasteriser
    // writes a restrained waxy-leaf roughness range and lets veins and dry
    // margins become only slightly more matte.
    roughness[offset] = toByte(fields.surfaceRoughness[index]!)
    roughness[offset + 1] = toByte(fields.translucency[index]!)
    roughness[offset + 2] = toByte(occlusion[index]!)
    roughness[offset + 3] = byteAlpha
  }
  const normal = new Uint8Array(pixels * 4)
  packNormals(fields.height, fields.basis, alpha, normal, size)
  return { albedo, normal, roughness, size }
}

/**
 * Rasterises one blade filling the frame. A diagnostic: in a finished spray
 * thirty overlapping leaves make it impossible to tell whether the outline
 * itself is wrong or whether the overlaps only look that way.
 */
export function bakeSingleBlade(
  species: TreeSpecies,
  variation: number,
  size: number,
): Uint8Array {
  const rgba = new Uint8Array(size * size * 4)
  const profile = leafProfileFor(species)
  const shape = makeBladeShape(profile, variation, profile.aspect)
  const bladeColour = leafBaseColour(profile, variation, 1)
  // One scale for both axes, so the blade is shown at its true proportions.
  // Fitting width and length to the frame independently — which is what an
  // obvious "fill the frame" mapping does — stretches a 1:0.6 leaf to 1:1 and
  // makes every judgement about how broad the outline is worthless.
  const frame = 0.88
  for (let y = 0; y < size; y += 1) {
    const u = (1 - (y + 0.5) / size - (1 - frame) / 2) / frame
    for (let x = 0; x < size; x += 1) {
      const v = ((x + 0.5) / size - 0.5) / frame
      const halfWidth = shape.halfWidth(u, Math.sign(v) || 1)
      const inside = u >= 0 && u <= 1.02 && Math.abs(v) <= halfWidth
      const veins = inside ? shape.veins(u, v, Math.sign(v) || 1) : undefined
      const lift = veins ? clamp01(veins.midrib * 0.8 + veins.lateral * 0.65) * 0.07 : 0
      const offset = (y * size + x) * 4
      rgba[offset] = inside ? toByte(bladeColour[0] + lift) : 150
      rgba[offset + 1] = inside ? toByte(bladeColour[1] + lift) : 150
      rgba[offset + 2] = inside ? toByte(bladeColour[2] + lift * 0.3) : 150
      rgba[offset + 3] = 255
    }
  }
  return rgba
}

function toByte(value: number): number {
  return Math.round(clamp01(value) * 255)
}
