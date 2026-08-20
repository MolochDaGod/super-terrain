import { describe, expect, it } from 'vitest'
import { ARID_SURFACE_LAYERS, SURFACE_LAYERS } from './surface'

// Whether this file's shader code actually compiles is checked in
// `shaderCost.test.ts`, which walks the graph with a real WGSL builder. Merely
// constructing the nodes here would prove nothing: `Fn` bodies are lazy and do
// not execute until a NodeBuilder expands them.

describe('climate layer tables', () => {
  it('define the same roles, so the two can cross-fade', () => {
    expect(Object.keys(ARID_SURFACE_LAYERS)).toEqual(Object.keys(SURFACE_LAYERS))
  })

  it('keep every reflectance physically plausible', () => {
    for (const layer of Object.values(ARID_SURFACE_LAYERS)) {
      for (const channel of layer.albedo) {
        expect(channel).toBeGreaterThan(0)
        // Nothing in a desert outreflects fresh snow.
        expect(channel).toBeLessThan(0.8)
      }
      expect(layer.roughness).toBeGreaterThan(0.05)
      expect(layer.roughness).toBeLessThanOrEqual(1)
    }
  })

  it('makes sand markedly brighter and warmer than alpine soil', () => {
    const sand = ARID_SURFACE_LAYERS.soil.albedo
    const soil = SURFACE_LAYERS.soil.albedo
    expect(sand[0]).toBeGreaterThan(soil[0] * 2)
    // Warm: red leads blue by a wide margin.
    expect(sand[0]).toBeGreaterThan(sand[2] * 1.5)
  })
})
