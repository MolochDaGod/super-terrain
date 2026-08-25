import { describe, expect, it } from 'vitest'
import { sampleShallowBlocks } from './shallowBlocks'

describe('shallow bark blocks', () => {
  it('wraps exactly across both texture seams', () => {
    for (const [u, v] of [[0.013, 0.07], [0.42, 0.51], [0.97, 0.94]]) {
      const sample = sampleShallowBlocks(u, v, 18, 24, 84721)
      for (const wrapped of [
        sampleShallowBlocks(u + 1, v, 18, 24, 84721),
        sampleShallowBlocks(u, v + 1, 18, 24, 84721),
      ]) {
        expect(wrapped.majorBorder).toBeCloseTo(sample.majorBorder, 12)
        expect(wrapped.majorStrength).toBeCloseTo(sample.majorStrength, 12)
        expect(wrapped.plateIdentity).toBe(sample.plateIdentity)
      }
    }
  })

  it('keeps a varied, shallow hierarchy instead of uniformly outlining cells', () => {
    let minimum = 1
    let maximum = 0
    let sum = 0
    const count = 48 * 64
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 48; x += 1) {
        const strength = sampleShallowBlocks(x / 48, y / 64, 18, 24, 84721).majorStrength
        minimum = Math.min(minimum, strength)
        maximum = Math.max(maximum, strength)
        sum += strength
      }
    }
    expect(minimum).toBeLessThan(0.35)
    expect(maximum).toBeGreaterThan(0.8)
    expect(sum / count).toBeGreaterThan(0.45)
    expect(sum / count).toBeLessThan(0.75)
  })
})
