import { describe, expect, it } from 'vitest'
import { bakeLeafSpray } from '../leafSprayAtlas'
import { buildCutoutMipmaps } from './mipmaps'

const SIZE = 256
const ALPHA_TEST = 0.3
const spray = bakeLeafSpray(84721, 'ancient-oak', 1, SIZE)

function coverage(data: Uint8Array): number {
  let kept = 0
  for (let index = 3; index < data.length; index += 4) {
    if (data[index]! > ALPHA_TEST * 255) kept += 1
  }
  return kept / (data.length / 4)
}

describe('cutout mipmaps', () => {
  it('runs the chain down to a single texel', () => {
    const levels = buildCutoutMipmaps(spray.albedo, SIZE, 'srgb-cutout', ALPHA_TEST)
    expect(levels).toHaveLength(Math.log2(SIZE) + 1)
    expect(levels[0]!.width).toBe(SIZE)
    expect(levels.at(-1)!.width).toBe(1)
  })

  it('holds canopy density constant as the camera pulls back', () => {
    // Plain box filtering erodes alpha, so a blade's half-opaque rim falls
    // below the alpha test a level or two down and the crown visibly thins.
    const levels = buildCutoutMipmaps(spray.albedo, SIZE, 'srgb-cutout', ALPHA_TEST)
    const full = coverage(levels[0]!.data)
    for (const level of levels.slice(1, 5)) {
      const ratio = coverage(level.data) / full
      expect(ratio).toBeGreaterThan(0.82)
      expect(ratio).toBeLessThan(1.2)
    }
  })

  it('keeps normals unit length instead of flattening them', () => {
    const levels = buildCutoutMipmaps(spray.normal, SIZE, 'normal-cutout', 0)
    for (const level of levels.slice(0, 5)) {
      let shortest = Infinity
      for (let index = 0; index < level.data.length; index += 4) {
        if (level.data[index + 3]! < 128) continue
        shortest = Math.min(shortest, Math.hypot(
          level.data[index]! / 127.5 - 1,
          level.data[index + 1]! / 127.5 - 1,
          level.data[index + 2]! / 127.5 - 1,
        ))
      }
      if (shortest === Infinity) continue
      expect(shortest).toBeGreaterThan(0.9)
    }
  })

  it('does not darken the albedo on the way down', () => {
    // Filtering sRGB bytes as if they were linear pulls every downsample of a
    // high-contrast cutout toward black, and leaf against sky is about as
    // high-contrast as a texture gets.
    const levels = buildCutoutMipmaps(spray.albedo, SIZE, 'srgb-cutout', ALPHA_TEST)
    const brightness = (level: { data: Uint8Array }) => {
      let total = 0
      let weight = 0
      for (let index = 0; index < level.data.length; index += 4) {
        const alpha = level.data[index + 3]! / 255
        if (alpha <= 0.01) continue
        total += (level.data[index]! + level.data[index + 1]! + level.data[index + 2]!) * alpha
        weight += alpha
      }
      return total / Math.max(1, weight)
    }
    const full = brightness(levels[0]!)
    for (const level of levels.slice(1, 3)) {
      expect(brightness(level)).toBeGreaterThan(full * 0.9)
      expect(brightness(level)).toBeLessThan(full * 1.1)
    }
    // Once a whole spray collapses into a handful of samples, the remaining
    // texels represent unresolved leaf area as well as literal albedo.  A
    // bounded linear-space gain prevents the distant crown turning charcoal.
    expect(brightness(levels[4]!)).toBeGreaterThan(full * 1.08)
    expect(brightness(levels[4]!)).toBeLessThan(full * 1.35)
  })
})
