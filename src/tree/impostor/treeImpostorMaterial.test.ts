import { describe, expect, it } from 'vitest'
import { DataTexture } from 'three/webgpu'
import { measureShaderCost } from '../../terrain/rendering/full/shaderCost'
import { createTreeImpostorMaterial } from './treeImpostorMaterial'

describe('the tree impostor material', () => {
  it('compiles to WGSL', () => {
    // `Fn` bodies are lazy, so building the node graph proves nothing on its
    // own. Only a real NodeBuilder walk expands the billboard frame and the
    // atlas cell selection, which is where every mistake in this file lives.
    const cost = measureShaderCost(
      createTreeImpostorMaterial({
        atlas: new DataTexture(new Uint8Array(4), 1, 1),
        radius: 2.4,
        halfHeight: 6.1,
        centreHeight: 6.1,
        nearFadeStart: 55,
        nearFadeEnd: 95,
      }),
    )
    expect(cost.wgsl).toContain('fn main(')
    expect(cost.mainLines).toBeGreaterThan(20)
  })
})
