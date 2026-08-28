import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createGiComputePasses } from './kernels.ts'
import { createIndirectNode, createGiUniforms } from './irradianceNode.ts'

describe('TSL WebGPU GI path is shipped', () => {
  it('exports compute kernels and an irradiance node from the real modules', () => {
    expect(typeof createGiComputePasses).toBe('function')
    expect(typeof createIndirectNode).toBe('function')
    expect(typeof createGiUniforms).toBe('function')
  })

  it('implements Sousa stages in TSL source (visibility, gather, denoise, volume sample)', () => {
    const dir = resolve(import.meta.dirname)
    const kernels = readFileSync(resolve(dir, 'kernels.ts'), 'utf8')
    const irradiance = readFileSync(resolve(dir, 'irradianceNode.ts'), 'utf8')
    const gi = readFileSync(resolve(dir, '../IdTechGI.ts'), 'utf8')
    expect(kernels).toMatch(/from 'three\/tsl'/)
    expect(kernels).toMatch(/texture3D/)
    expect(kernels).toMatch(/Loop/)
    expect(kernels).toMatch(/textureStore/)
    expect(kernels).toMatch(/visibility/)
    expect(kernels).toMatch(/gather/)
    expect(kernels).toMatch(/denoise/)
    expect(kernels).toMatch(/hitsPos\.element\(id\)\.assign/)
    expect(kernels).toMatch(/screenCache/)
    expect(kernels).toMatch(/radianceCache/)
    expect(kernels).toMatch(/Fallback 1: screen-space/)
    expect(kernels).toMatch(/Fallback 2: world radiance cache/)
    expect(kernels).toMatch(/Fallback 3: irradiance volumes/)
    expect(irradiance).toMatch(/texture3D/)
    expect(irradiance).toMatch(/screenUV/)
    expect(irradiance).toMatch(/denoise/)
    expect(irradiance).toMatch(/SH_A0/)
    expect(gi).toMatch(/renderer\.compute/)
    expect(gi).toMatch(/WebGPU/)
    expect(gi).toMatch(/passes\.denoiseR/)
    expect(gi).not.toMatch(/gpuCompute = false/)
  })
})
