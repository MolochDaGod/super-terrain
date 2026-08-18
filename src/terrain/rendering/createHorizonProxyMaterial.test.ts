import { describe, expect, it } from 'vitest'
import { createHorizonProxyMaterial } from './createHorizonProxyMaterial'

describe('horizon proxy material', () => {
  it.each(['preview', 'full'] as const)(
    'pins the %s backdrop behind resident geometry',
    (mode) => {
      const material = createHorizonProxyMaterial(mode)

      expect(material.depthNode).not.toBeNull()
      expect(material.depthTest).toBe(true)
      expect(material.depthWrite).toBe(true)
      expect(material.stencilWrite).toBe(false)

      material.dispose()
    },
  )
})
