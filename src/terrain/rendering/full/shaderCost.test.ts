import { describe, expect, it } from 'vitest'
import { createFullTerrainMaterial } from './createFullTerrainMaterial'
import { measureShaderCost } from './shaderCost'

describe('the full terrain material', () => {
  const cost = measureShaderCost(createFullTerrainMaterial().material)

  it('compiles to WGSL', () => {
    // Reaching a fragment entry point at all means every node in the graph was
    // walked and emitted, which is the check TypeScript cannot perform.
    expect(cost.wgsl).toContain('fn main(')
    expect(cost.mainLines).toBeGreaterThan(50)
  })

  it('stays within its Perlin noise budget', () => {
    // Surface detail is texture-baked. A future material change must not
    // quietly put the old fragment-noise workload back into the hot path.
    expect(cost.perlinCallSites).toBe(0)
  })

  it('stays within its code-size budget', () => {
    // Every one of these lines is compiled again per shadow cascade. Growth
    // here is paid five times over on the switch into full mode, where it shows
    // up as a stall rather than as a frame-rate cost.
    expect(cost.mainLines).toBeLessThan(1_200)
    expect(cost.totalLines).toBeLessThan(2_100)
  })
})
