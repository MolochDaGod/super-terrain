import { describe, expect, it } from 'vitest'
import {
  cascadeCellSize,
  cellCenter,
  interleavedUpdateSet,
  packProbeIndex,
  unpackProbeIndex,
} from './cascades.ts'
import { DEFAULT_CASCADE } from './types.ts'

describe('cascaded probe selection', () => {
  const camera: [number, number, number] = [1.5, 2.5, -3]
  const config = { ...DEFAULT_CASCADE, resolution: 4, cascadeCount: 3 }

  it('places probes at cell centers, not corners', () => {
    const center = cellCenter(0, 0, 0, 0, camera, config)
    const cell = cascadeCellSize(0, config)
    // A corner would land on a multiple of `cell` after origin snap; a center
    // is always origin + (i+0.5)*cell.
    const originOffsetX = center[0] - Math.floor(center[0] / cell) * cell
    expect(originOffsetX).toBeCloseTo(cell * 0.5, 5)
    expect(center[0]).not.toBe(camera[0])
  })

  it('interleaves a different cascade each frame and covers every cell of it', () => {
    const a = interleavedUpdateSet(0, camera, config)
    const b = interleavedUpdateSet(1, camera, config)
    const c = interleavedUpdateSet(2, camera, config)
    const d = interleavedUpdateSet(3, camera, config)
    expect(a.cascade).toBe(0)
    expect(b.cascade).toBe(1)
    expect(c.cascade).toBe(2)
    expect(d.cascade).toBe(0)
    expect(a.probes).toHaveLength(4 * 4 * 4)
    expect(new Set(a.probes.map((p) => p.index)).size).toBe(64)
    const packed = packProbeIndex(1, 2, 3, 1, 4)
    expect(unpackProbeIndex(packed, 4)).toEqual({ cascade: 1, ix: 2, iy: 3, iz: 1 })
  })

  it('keeps cell centers stable when the camera moves less than a cell', () => {
    const cell = cascadeCellSize(0, config)
    const p0 = cellCenter(0, 1, 1, 1, camera, config)
    const p1 = cellCenter(0, 1, 1, 1, [camera[0] + cell * 0.2, camera[1], camera[2]], config)
    expect(p0).toEqual(p1)
  })
})
