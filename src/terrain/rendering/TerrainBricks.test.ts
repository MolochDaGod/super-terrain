import { describe, expect, it } from 'vitest'
import { BufferAttribute, BufferGeometry } from 'three/webgpu'
import { createTerrainBrickGeometries } from './TerrainBricks'

describe('terrain brick partitioning', () => {
  it('clusters triangles into cubic cells without duplicating index work', () => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([
      0, 0, 0, 8, 0, 0, 0, 0, 8,
      72, 65, 72, 80, 65, 72, 72, 65, 80,
    ]), 3))
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(18), 3))
    geometry.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2, 3, 4, 5]), 1))

    const bricks = createTerrainBrickGeometries(geometry, 64)

    expect(bricks.map((brick) => brick.cellKey)).toEqual(['0:0:0', '1:1:1'])
    expect(bricks.reduce((sum, brick) => sum + brick.triangleCount, 0)).toBe(2)
    expect(bricks[0].geometry.getAttribute('position')).toBe(
      geometry.getAttribute('position'),
    )
    expect(bricks[1].geometry.boundingBox?.min.y).toBe(65)
  })
})
