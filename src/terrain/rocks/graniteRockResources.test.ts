import { describe, expect, it } from 'vitest'
import {
  atlasTriangleIsContinuous,
  createGraniteGeometry,
} from './graniteRockResources'

describe('granite atlas seam guard', () => {
  it('keeps triangles contained inside one atlas chart', () => {
    expect(atlasTriangleIsContinuous(
      new Float32Array([0.1, 0.2, 0.12, 0.23, 0.14, 0.19]),
      0,
      1,
      2,
    )).toBe(true)
  })

  it('rejects interpolation between unrelated atlas islands', () => {
    expect(atlasTriangleIsContinuous(
      new Float32Array([0.1, 0.2, 0.82, 0.76, 0.14, 0.19]),
      0,
      1,
      2,
    )).toBe(false)
  })

  it('preserves smooth LOD normals on seam-fallback triangles', () => {
    const geometry = createGraniteGeometry(
      new Float32Array([
        0, 0, 0,
        1, 0, 0,
        1, 0, 1,
        0, 0, 0,
        1, 0, 1,
        0, 1, 1,
      ]),
      new Float32Array([
        0.10, 0.10,
        0.12, 0.10,
        0.12, 0.12,
        0.10, 0.10,
        0.12, 0.12,
        0.80, 0.80,
      ]),
      new Uint32Array([0, 1, 2, 3, 4, 5]),
      0,
    )
    const index = geometry.getIndex()!
    const normal = geometry.getAttribute('normal')
    const validity = geometry.getAttribute('graniteBakeValid')
    const sharedOriginal = index.getX(0)
    const sharedFallback = index.getX(3)

    expect(validity.getX(sharedFallback)).toBe(0)
    expect(normal.getX(sharedFallback)).toBeCloseTo(normal.getX(sharedOriginal))
    expect(normal.getY(sharedFallback)).toBeCloseTo(normal.getY(sharedOriginal))
    expect(normal.getZ(sharedFallback)).toBeCloseTo(normal.getZ(sharedOriginal))

    geometry.dispose()
  })

  it('guards LOD1 against any discontinuous triangle left after simplification', () => {
    const geometry = createGraniteGeometry(
      new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]),
      new Float32Array([
        0.05, 0.05,
        0.9, 0.8,
        0.15, 0.92,
      ]),
      new Uint32Array([0, 1, 2]),
      1,
    )

    expect(geometry.userData.graniteAtlas.discontinuousTriangles).toBe(1)
    expect(geometry.getAttribute('graniteBakeValid').getX(3)).toBe(0)

    geometry.dispose()
  })
})
