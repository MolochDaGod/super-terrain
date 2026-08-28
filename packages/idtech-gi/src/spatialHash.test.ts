import { describe, expect, it } from 'vitest'
import {
  WorldRadianceCache,
  cellChecksum,
  cellLod,
  hashCellKey,
  quantizePosition,
} from './spatialHash.ts'
import { DEFAULT_CACHE } from './types.ts'

describe('world radiance cache spatial hash', () => {
  it('quantizes nearby points into the same cell and distant points apart', () => {
    const a = quantizePosition([0.02, 0.02, 0.02], DEFAULT_CACHE, 1)
    const b = quantizePosition([0.10, 0.04, 0.08], DEFAULT_CACHE, 1)
    const c = quantizePosition([4, 0, 0], DEFAULT_CACHE, 1)
    expect(a).toEqual(b)
    expect(hashCellKey(a)).toBe(hashCellKey(b))
    expect(cellChecksum(a)).toBe(cellChecksum(b))
    expect(a.ix).not.toBe(c.ix)
  })

  it('inserts a cell and looks it up across frames as a reuse', () => {
    const cache = new WorldRadianceCache({ ...DEFAULT_CACHE, reuseFrames: 4 })
    const pos: [number, number, number] = [1.1, 2.2, 3.3]
    const first = cache.insert(
      pos,
      2,
      { radiance: [0.8, 0.1, 0.05], normal: [0, 1, 0], albedo: [1, 0, 0] },
      10,
    )
    expect(first.reused).toBe(false)
    expect(first.entry?.radiance).toEqual([0.8, 0.1, 0.05])

    const found = cache.lookup(pos, 2, 12)
    expect(found.entry).not.toBeNull()
    expect(found.reused).toBe(true)
    expect(found.entry?.radiance).toEqual([0.8, 0.1, 0.05])
    expect(found.index).toBe(first.index)

    const sample = cache.sample(pos, 2, 13)
    expect(sample).toEqual([0.8, 0.1, 0.05])
  })

  it('does not reuse a cell after reuseFrames have elapsed', () => {
    const cache = new WorldRadianceCache({ ...DEFAULT_CACHE, reuseFrames: 2 })
    const pos: [number, number, number] = [0.4, 0.1, 0.2]
    cache.insert(pos, 1, { radiance: [1, 1, 1], normal: [0, 1, 0], albedo: [1, 1, 1] }, 0)
    expect(cache.lookup(pos, 1, 2).reused).toBe(true)
    expect(cache.lookup(pos, 1, 3).reused).toBe(false)
  })

  it('grows LOD cell size with camera distance', () => {
    expect(cellLod(0, 8)).toBe(1)
    expect(cellLod(8, 8)).toBe(2)
    expect(cellLod(24, 8)).toBe(4)
    const near = quantizePosition([1.9, 0, 0], DEFAULT_CACHE, 0.5)
    const far = quantizePosition([1.9, 0, 0], DEFAULT_CACHE, 80)
    expect(far.lod).toBeGreaterThan(near.lod)
  })
})
