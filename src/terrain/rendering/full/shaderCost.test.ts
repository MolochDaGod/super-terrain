import { describe, expect, it } from 'vitest'
import { createFullTerrainMaterial } from './createFullTerrainMaterial'
import { measureShaderCost } from './shaderCost'

describe('the full terrain material', () => {
  const cost = measureShaderCost(createFullTerrainMaterial().material)

  it('compiles to WGSL', () => {
    // Reaching a fragment entry point at all means every node in the graph was
    // walked and emitted, which is the check TypeScript cannot perform.
    expect(cost.wgsl).toContain('fn main(')
    expect(cost.mainLines).toBeGreaterThan(100)
  })

  it('stays within its Perlin noise budget', () => {
    // Measured at 42 with both biomes in. This is the number that decides
    // whether the material is renderable, so it gets a tight bound rather than
    // a generous one: an accidental extra octave in a shared field multiplies
    // through every layer that reads it and lands here as four or five.
    expect(cost.perlinCallSites).toBeLessThanOrEqual(44)
  })

  it('stays within its code-size budget', () => {
    // Every one of these lines is compiled again per shadow cascade. Growth
    // here is paid five times over on the switch into full mode, where it shows
    // up as a stall rather than as a frame-rate cost.
    expect(cost.mainLines).toBeLessThan(1_200)
    expect(cost.totalLines).toBeLessThan(2_100)
  })
})
