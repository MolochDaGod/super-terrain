import { describe, expect, it } from 'vitest'
import {
  cameraSectionDistance,
  constrainNeighborLods,
  detailFocusLodCeiling,
  focusedLodCeiling,
  projectedGeometricError,
  selectLod,
  selectSourceLod,
} from './LodSelector'

const lods = [
  { level: 0, geometricError: 0.4 },
  { level: 1, geometricError: 1 },
  { level: 2, geometricError: 2.5 },
  { level: 3, geometricError: 6 },
  { level: 4, geometricError: 14 },
]

describe('screen-space LOD selection', () => {
  it('anchors the finest-detail patch to the camera section, not the origin', () => {
    const camera = { x: 512, y: 300, z: -256 }
    expect(cameraSectionDistance({ x: 4, z: -2 }, camera, 128)).toBe(0)
    expect(cameraSectionDistance({ x: 0, z: 0 }, camera, 128)).toBeCloseTo(
      Math.sqrt(20),
    )
  })

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

  it('keeps the framed editing patch at real LOD0 from orbit distance', () => {
    const terrainLods = [
      { level: 0, geometricError: 0 },
      { level: 1, geometricError: 0.083 },
      { level: 2, geometricError: 0.398 },
      { level: 3, geometricError: 0.79 },
      { level: 4, geometricError: 1.58 },
    ]
    const orbitView = {
      lods: terrainLods,
      distance: 400,
      viewportHeight: 720,
      verticalFovRadians: (48 * Math.PI) / 180,
      errorTolerancePixels: 2.2,
      currentLod: 3,
    }
    expect(selectLod(orbitView)).toBeGreaterThan(0)
    expect(selectLod({
      ...orbitView,
      focusDistanceSections: Math.SQRT2,
      lod0FocusRadiusSections: 1.75,
    })).toBe(0)
    expect(selectLod({
      ...orbitView,
      focusDistanceSections: 2,
      lod0FocusRadiusSections: 1.75,
    })).toBe(1)
    expect(focusedLodCeiling(Math.SQRT2, 1.75, 4)).toBe(0)
    expect(focusedLodCeiling(Math.sqrt(8), 1.75, 4)).toBe(2)
  })

  it('keeps a distant presentation subject dense without refining the whole world', () => {
    const focus = {
      x: 620,
      z: 410,
      radiusSections: 1.5,
      finestLod: 0,
    }
    expect(detailFocusLodCeiling({ x: 5, z: 3 }, focus, 128, 4)).toBe(0)
    expect(detailFocusLodCeiling({ x: 6, z: 3 }, focus, 128, 4)).toBe(1)
    expect(detailFocusLodCeiling({ x: 7, z: 3 }, focus, 128, 4)).toBe(2)
    expect(detailFocusLodCeiling({ x: 10, z: 3 }, focus, 128, 4)).toBe(4)
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

  it('returns global levels when a compiled section contains a sparse LOD set', () => {
    const sparse = lods.slice(2)
    expect(
      selectLod({
        lods: sparse,
        distance: 8_000,
        viewportHeight: 1080,
        verticalFovRadians: Math.PI / 3,
        errorTolerancePixels: 2,
        currentLod: 4,
      }),
    ).toBe(4)
    expect(
      selectLod({
        lods: sparse,
        distance: 70,
        viewportHeight: 1080,
        verticalFovRadians: Math.PI / 3,
        errorTolerancePixels: 2,
        currentLod: 2,
      }),
    ).toBe(2)
  })

  it('stages source grids by projected screen error', () => {
    const input = {
      lodResolutions: [96, 48, 24, 12, 6],
      sectionSize: 128,
      viewportHeight: 720,
      verticalFovRadians: (48 * Math.PI) / 180,
      errorTolerancePixels: 2.2,
    }
    expect(selectSourceLod({ ...input, distance: 64 })).toBe(0)
    expect(selectSourceLod({ ...input, distance: 256 })).toBe(2)
    expect(selectSourceLod({ ...input, distance: 1_280 })).toBe(4)
  })
})
