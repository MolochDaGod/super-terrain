import { describe, expect, it } from 'vitest'
import { DataTexture, RedFormat } from 'three/webgpu'
import { createHorizonProxyMaterial } from './createHorizonProxyMaterial'

describe('horizon proxy material', () => {
  it.each(['preview', 'full'] as const)(
    'keeps perspective depth for the %s backdrop',
    (mode) => {
      const mask = new DataTexture(new Uint8Array([0]), 1, 1, RedFormat)
      const material = createHorizonProxyMaterial(mode, mask, 16_384)

      expect(material.depthNode).toBeNull()
      expect(material.depthTest).toBe(true)
      expect(material.depthWrite).toBe(true)
      expect(material.stencilWrite).toBe(false)
      expect(material.opacityNode).not.toBeNull()
      expect(material.alphaTest).toBe(0.5)
      expect(material.alphaToCoverage).toBe(true)

      material.dispose()
      mask.dispose()
    },
  )
})
