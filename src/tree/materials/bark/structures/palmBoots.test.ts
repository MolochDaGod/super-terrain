import { describe, expect, it } from 'vitest'
import { samplePalmBoots } from './palmBoots'

describe('palm boot structure', () => {
  it('tiles at both atlas seams', () => {
    for (const coordinate of [0, 0.13, 0.37, 0.71, 0.99]) {
      const left = samplePalmBoots(0, coordinate, 7, 18, 62039)
      const right = samplePalmBoots(1, coordinate, 7, 18, 62039)
      expect(right.majorBorder).toBeCloseTo(left.majorBorder, 8)
      expect(right.majorStrength).toBeCloseTo(left.majorStrength, 8)

      const bottom = samplePalmBoots(coordinate, 0, 7, 18, 62039)
      const top = samplePalmBoots(coordinate, 1, 7, 18, 62039)
      expect(top.majorBorder).toBeCloseTo(bottom.majorBorder, 8)
      expect(top.majorStrength).toBeCloseTo(bottom.majorStrength, 8)
    }
  })

  it('varies boot size and depth across staggered rows', () => {
    const samples = Array.from({ length: 80 }, (_, index) =>
      samplePalmBoots((index * 0.137) % 1, (index * 0.091) % 1, 7, 18, 62039))
    const strengths = samples.map((sample) => sample.majorStrength)
    expect(Math.max(...strengths) - Math.min(...strengths)).toBeGreaterThan(0.25)
    expect(samples.some((sample) => sample.majorBorder < 0.025)).toBe(true)
    expect(samples.some((sample) => sample.majorBorder > 0.12)).toBe(true)
  })
})
