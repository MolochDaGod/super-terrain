import { describe, expect, it } from 'vitest'
import { Box3, Matrix4, Vector3 } from 'three/webgpu'
import { buildHiZPyramid, isBoxOccluded } from './TerrainHiZOcclusion'

describe('terrain Hi-Z culling', () => {
  it('builds a conservative max-depth pyramid', () => {
    const pyramid = buildHiZPyramid(new Float32Array([
      0.1, 0.2, 0.3, 0.4,
      0.2, 0.5, 0.4, 0.3,
      0.1, 0.2, 0.8, 0.4,
      0.2, 0.3, 0.4, 0.6,
    ]), 4, 4)

    expect(pyramid.levels.map((level) => [level.width, level.height])).toEqual([
      [4, 4], [2, 2], [1, 1],
    ])
    expect(pyramid.levels[1].depths).toEqual(new Float32Array([0.5, 0.4, 0.3, 0.8]))
    expect(pyramid.levels[2].depths[0]).toBeCloseTo(0.8)
  })

  it('rejects a box only when every covered texel is nearer', () => {
    const depths = new Float32Array(16).fill(0.35)
    const pyramid = buildHiZPyramid(depths, 4, 4)
    const behind = new Box3(
      new Vector3(-0.2, -0.2, 0.7),
      new Vector3(0.2, 0.2, 0.8),
    )
    const inFront = new Box3(
      new Vector3(-0.2, -0.2, 0.1),
      new Vector3(0.2, 0.2, 0.2),
    )

    expect(isBoxOccluded(behind, new Matrix4(), pyramid)).toBe(true)
    expect(isBoxOccluded(inFront, new Matrix4(), pyramid)).toBe(false)
  })

  it('keeps near-plane intersections visible', () => {
    const pyramid = buildHiZPyramid(new Float32Array(16).fill(0.1), 4, 4)
    const crossing = new Box3(
      new Vector3(-0.1, -0.1, -0.1),
      new Vector3(0.1, 0.1, 0.2),
    )
    expect(isBoxOccluded(crossing, new Matrix4(), pyramid)).toBe(false)
  })
})
