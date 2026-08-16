import { describe, expect, it } from 'vitest'
import { constrainNeighborLods, projectedGeometricError, selectLod } from './LodSelector'

const lods = [
  { level: 0, geometricError: 0.4 },
  { level: 1, geometricError: 1 },
  { level: 2, geometricError: 2.5 },
  { level: 3, geometricError: 6 },
  { level: 4, geometricError: 14 },
]

describe('screen-space LOD selection', () => {
  it('selects finer geometry near the camera and coarse geometry far away', () => {
    const near = selectLod({
      lods,
      distance: 70,
      viewportHeight: 1080,
      verticalFovRadians: Math.PI / 3,
      errorTolerancePixels: 2,
      currentLod: 0,
    })
    const far = selectLod({
      lods,
      distance: 8_000,
      viewportHeight: 1080,
      verticalFovRadians: Math.PI / 3,
      errorTolerancePixels: 2,
      currentLod: 4,
    })
    expect(near).toBe(0)
    expect(far).toBe(4)
  })

  it('uses hysteresis instead of flipping exactly at the threshold', () => {
    const distance = (lods[2].geometricError * (1080 / (2 * Math.tan(Math.PI / 6)))) / 2
    expect(projectedGeometricError(lods[2].geometricError, distance, 1080, Math.PI / 3)).toBeCloseTo(2)
    const selected = selectLod({
      lods,
      distance,
      viewportHeight: 1080,
      verticalFovRadians: Math.PI / 3,
      errorTolerancePixels: 2,
      currentLod: 1,
    })
    expect(selected).toBe(1)
  })

  it('limits adjacent visible sections to one LOD step', () => {
    const constrained = constrainNeighborLods([
      { id: '0:0', x: 0, z: 0, lod: 0 },
      { id: '1:0', x: 1, z: 0, lod: 4 },
      { id: '2:0', x: 2, z: 0, lod: 4 },
    ])
    expect(constrained.get('1:0')).toBe(1)
    expect(constrained.get('2:0')).toBe(2)
  })
})
