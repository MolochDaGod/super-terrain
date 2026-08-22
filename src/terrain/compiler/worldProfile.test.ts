import { afterEach, describe, expect, it } from 'vitest'
import {
  FLAT_GROUND_LEVEL,
  sampleHeightField,
  setWorldProfile,
} from './heightField'
import { WATER_LEVEL } from './climate'

afterEach(() => setWorldProfile('natural'))

describe('world profile', () => {
  it('produces real relief in the natural profile', () => {
    setWorldProfile('natural')
    const heights = [0, 400, 800, 1200].map(
      (x) => sampleHeightField(x, 200, 13_371).height,
    )
    const spread = Math.max(...heights) - Math.min(...heights)
    // A range's worth of variation across a kilometre, not a rolling field.
    expect(spread).toBeGreaterThan(60)
  })

  it('flattens the world without flattening it to a dead plane', () => {
    setWorldProfile('flat')
    const heights = [0, 250, 700, 1300].map(
      (x) => sampleHeightField(x, 120, 4).height,
    )
    for (const height of heights) {
      // Dry, so a fresh flat world is not born underwater.
      expect(height).toBeGreaterThan(WATER_LEVEL)
      expect(Math.abs(height - FLAT_GROUND_LEVEL)).toBeLessThan(6)
    }
    const spread = Math.max(...heights) - Math.min(...heights)
    // Enough swell for the sun to read against, so a brush stroke is legible.
    expect(spread).toBeGreaterThan(0.05)
  })

  it('reports no massif and no drainage on flat ground', () => {
    setWorldProfile('flat')
    const sample = sampleHeightField(320, -180, 9)
    expect(sample.massif).toBe(0)
    expect(sample.valley).toBe(0)
    expect(sample.flow).toBe(0)
  })
})
