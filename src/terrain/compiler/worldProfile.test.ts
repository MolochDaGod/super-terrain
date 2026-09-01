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

  it('keeps joint-facet transitions sample-safe at LOD0 spacing', () => {
    setWorldProfile('natural')
    const spacing = 128 / 88
    // This pair lies on the rear massif where the hard plane switch formerly
    // introduced a 56 m drop between two LOD0 neighbours.
    const x = 462.181818181816
    const z = 473.81818181817954
    const source = sampleHeightField(x, z, 13_371)
    const neighbour = sampleHeightField(x, z + spacing, 13_371)
    const step = Math.abs(neighbour.height - source.height)

    // LOD0 is sampled 1.45 m apart. The base mountain can legitimately be
    // steep, but a joint cut must not add another cliff-sized jump: that
    // creates edge-on pseudo-walls that read as holes at a grazing camera.
    expect(step).toBeLessThan(15)
  })
})
