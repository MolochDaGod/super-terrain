import { describe, expect, it } from 'vitest'
import { bakeLeafSpray } from '../leafSprayAtlas'
import { layoutSpray } from './layout'
import { leafProfileFor } from './profiles'

const profile = leafProfileFor('live-oak')

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!
}

describe('live-oak foliage profile', () => {
  it('uses a smaller, narrower and genuinely varied blade population', () => {
    expect(profile.aspect).toBeLessThanOrEqual(0.22)
    expect(profile.spray?.scale).toBeLessThan(0.75)

    const layouts = Array.from({ length: 4 }, (_, variant) =>
      layoutSpray(84721 + variant * 7717, variant, profile))
    const leaves = layouts.flatMap((layout) => layout.leaves)
    const lengths = leaves.map((leaf) => leaf.length)

    expect(percentile(lengths, 0.9) / percentile(lengths, 0.1)).toBeGreaterThan(1.6)
    expect(Math.min(...leaves.map((leaf) => leaf.squash))).toBeLessThan(0.16)
    expect(new Set(layouts.map((layout) => layout.leaves.length)).size).toBe(4)
  })

  it('bakes leathery olive tissue rather than bright lime paddles', () => {
    const size = 256
    const spray = bakeLeafSpray(84721, 'live-oak', 1, size)
    const luminance: number[] = []
    const roughness: number[] = []
    let covered = 0
    for (let index = 0; index < size * size; index += 1) {
      if (spray.albedo[index * 4 + 3]! < 200) continue
      covered += 1
      luminance.push((
        0.2126 * spray.albedo[index * 4]! +
        0.7152 * spray.albedo[index * 4 + 1]! +
        0.0722 * spray.albedo[index * 4 + 2]!
      ) / 255)
      roughness.push(spray.roughness[index * 4]! / 255)
    }

    expect(covered / (size * size)).toBeGreaterThan(0.06)
    expect(covered / (size * size)).toBeLessThan(0.2)
    expect(percentile(luminance, 0.5)).toBeLessThan(0.28)
    expect(percentile(luminance, 0.9)).toBeLessThan(0.36)
    expect(percentile(roughness, 0.5)).toBeGreaterThan(0.6)
  })
})
