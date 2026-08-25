/**
 * Hand-built mip chains for the cutout atlases.
 *
 * The GPU's own mip generation is wrong for foliage in three separate ways, and
 * all three show up at exactly the distances most of a canopy is viewed from.
 *
 * It averages alpha, which erodes coverage: a blade whose rim texels are half
 * opaque falls below the alpha-test threshold a level or two down, so a crown
 * visibly thins out as the camera pulls back and the tree loses a third of its
 * leaves to a filter. Rescaling alpha per level so the same fraction of texels
 * survives the threshold is what holds a canopy's density constant.
 *
 * It filters sRGB bytes as if they were linear, which darkens every downsample
 * of a high-contrast cutout — leaf against sky is about as high-contrast as a
 * texture gets.
 *
 * And it averages normals without renormalising, which flattens the blade
 * orientations that were just baked into them.
 */

import { compensateCutoutEnergy } from './mipEnergy'

export interface MipLevel {
  data: Uint8Array
  width: number
  height: number
}

export type MipContent = 'srgb-cutout' | 'linear-cutout' | 'normal-cutout'

/**
 * Builds the whole chain, level 0 first, down to 1x1.
 *
 * `alphaTest` is the material's own threshold; passing it is what lets the
 * coverage correction know which texels the shader is going to keep.
 */
export function buildCutoutMipmaps(
  data: Uint8Array,
  size: number,
  content: MipContent,
  alphaTest: number,
): MipLevel[] {
  const levels: MipLevel[] = [{ data, width: size, height: size }]
  const target = coverageAt(data, alphaTest, 1)
  let current = levels[0]!
  while (current.width > 1) {
    current = reduce(current, content)
    if (alphaTest > 0) matchCoverage(current.data, alphaTest, target)
    if (content === 'srgb-cutout') {
      compensateCutoutEnergy(current.data, levels.length)
    }
    levels.push(current)
  }
  return levels
}

function reduce(level: MipLevel, content: MipContent): MipLevel {
  const width = Math.max(1, level.width >> 1)
  const height = Math.max(1, level.height >> 1)
  const data = new Uint8Array(width * height * 4)
  const srgb = content === 'srgb-cutout'
  const normal = content === 'normal-cutout'
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      let weight = 0
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const sourceX = Math.min(level.width - 1, x * 2 + dx)
          const sourceY = Math.min(level.height - 1, y * 2 + dy)
          const offset = (sourceY * level.width + sourceX) * 4
          const sampleAlpha = level.data[offset + 3]! / 255
          alpha += sampleAlpha
          // Weight colour by opacity so a mostly transparent texel cannot drag
          // the blade's colour toward whatever the dilation left behind it.
          // Fully transparent quads still need an answer, hence the fallback.
          const share = sampleAlpha + 1e-4
          weight += share
          if (normal) {
            red += (level.data[offset]! / 127.5 - 1) * share
            green += (level.data[offset + 1]! / 127.5 - 1) * share
            blue += (level.data[offset + 2]! / 127.5 - 1) * share
          } else if (srgb) {
            red += toLinear(level.data[offset]!) * share
            green += toLinear(level.data[offset + 1]!) * share
            blue += toLinear(level.data[offset + 2]!) * share
          } else {
            red += level.data[offset]! * share
            green += level.data[offset + 1]! * share
            blue += level.data[offset + 2]! * share
          }
        }
      }
      const offset = (y * width + x) * 4
      if (normal) {
        const nx = red / weight
        const ny = green / weight
        const nz = blue / weight
        // Renormalise, or every level flattens toward the average direction and
        // the blade orientations dissolve into one flat-facing sheet.
        const inverse = 1 / Math.max(1e-5, Math.sqrt(nx * nx + ny * ny + nz * nz))
        data[offset] = clampByte((nx * inverse + 1) * 127.5)
        data[offset + 1] = clampByte((ny * inverse + 1) * 127.5)
        data[offset + 2] = clampByte((nz * inverse + 1) * 127.5)
      } else if (srgb) {
        data[offset] = clampByte(toSrgb(red / weight))
        data[offset + 1] = clampByte(toSrgb(green / weight))
        data[offset + 2] = clampByte(toSrgb(blue / weight))
      } else {
        data[offset] = clampByte(red / weight)
        data[offset + 1] = clampByte(green / weight)
        data[offset + 2] = clampByte(blue / weight)
      }
      data[offset + 3] = clampByte((alpha / 4) * 255)
    }
  }
  return { data, width, height }
}

/**
 * Scales alpha so this level keeps the same fraction of texels above the
 * threshold as the full-resolution image did.
 *
 * Solved by bisection rather than in closed form: the relationship between the
 * scale and the surviving fraction is a step function over the actual histogram
 * of this level, and there is no formula for it.
 */
function matchCoverage(data: Uint8Array, alphaTest: number, target: number): void {
  if (target <= 0) return
  let low = 0.25
  let high = 4
  let scale = 1
  for (let step = 0; step < 12; step += 1) {
    scale = (low + high) / 2
    if (coverageAt(data, alphaTest, scale) > target) high = scale
    else low = scale
  }
  if (Math.abs(scale - 1) < 0.02) return
  for (let index = 3; index < data.length; index += 4) {
    data[index] = clampByte(data[index]! * scale)
  }
}

function coverageAt(data: Uint8Array, alphaTest: number, scale: number): number {
  const threshold = alphaTest * 255
  let kept = 0
  for (let index = 3; index < data.length; index += 4) {
    if (data[index]! * scale > threshold) kept += 1
  }
  return kept / (data.length / 4)
}

function toLinear(value: number): number {
  return SRGB_TO_LINEAR[value]!
}

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, value) => {
  const unit = value / 255
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
})

function toSrgb(value: number): number {
  const encoded = value <= 0.0031308
    ? value * 12.92
    : 1.055 * value ** (1 / 2.4) - 0.055
  return encoded * 255
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}
