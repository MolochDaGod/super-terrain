import { describe, expect, it } from 'vitest'
import { DEFAULT_TERRAIN_CONFIG } from '../../config'
import { sampleHeight } from '../../compiler/heightField'
import { WATER_LEVEL, WATER_REGION } from '../../demo/valleyFloor'
import { createWaterSurface } from './createWaterSurface'

const seed = DEFAULT_TERRAIN_CONFIG.seed

describe('valley water surface', () => {
  const geometry = createWaterSurface({
    region: WATER_REGION,
    level: WATER_LEVEL,
    seed,
  })

  it('is flat at the water level', () => {
    const positions = geometry.getAttribute('position')
    for (let index = 0; index < positions.count; index += 1) {
      expect(positions.getY(index)).toBe(WATER_LEVEL)
    }
  })

  it('carries the depth of water above the terrain at every vertex', () => {
    const positions = geometry.getAttribute('position')
    const depths = geometry.getAttribute('waterDepth')
    expect(depths.count).toBe(positions.count)
    for (const index of [0, 137, 4_211, positions.count - 1]) {
      const ground = sampleHeight(
        positions.getX(index),
        positions.getZ(index),
        seed,
      )
      expect(depths.getX(index)).toBeCloseTo(WATER_LEVEL - ground, 3)
    }
  })

  it('drops the cells that are entirely dry land', () => {
    const positions = geometry.getAttribute('position')
    const emitted = new Set(geometry.getIndex()!.array)
    expect(emitted.size).toBeGreaterThan(0)
    // The region has to span the whole basin to reach around the water, so most
    // of the rectangle is hillside. Keeping it would be tens of thousands of
    // invisible triangles.
    expect(emitted.size).toBeLessThan(positions.count * 0.7)
  })

  it('actually floods some of the basin', () => {
    const depths = geometry.getAttribute('waterDepth')
    let wet = 0
    for (let index = 0; index < depths.count; index += 1) {
      if (depths.getX(index) > 1) wet += 1
    }
    expect(wet).toBeGreaterThan(500)
  })
})
