import { describe, expect, it } from 'vitest'
import { boundaryOwner, cardinalNeighbors } from './boundary'
import { MeshPartition } from './MeshPartition'

describe('mesh partition', () => {
  it('propagates dirty regions through the operation halo', () => {
    const partition = new MeshPartition({ sectionSize: 128, worldSize: 1024, seed: 1 })
    const dirty = partition.invalidateBounds(
      {
        min: { x: 124, y: -2, z: 20 },
        max: { x: 126, y: 2, z: 25 },
      },
      8,
      100,
    )
    expect(dirty.map((section) => section.id).sort()).toEqual(['0:0', '1:0'])
    expect(dirty.every((section) => section.revision === 1)).toBe(true)
    expect(dirty.every((section) => section.dirtyRegion !== undefined)).toBe(true)
  })

  it('rejects stale build results without replacing current source state', () => {
    const partition = new MeshPartition({ sectionSize: 128, worldSize: 1024, seed: 1 })
    const section = partition.getOrCreate({ x: 0, z: 0 })
    partition.markDirty(section, section.bounds)
    expect(
      partition.acceptCompiled(section, {
        key: section.key,
        sourceRevision: 0,
        bounds: section.bounds,
        lods: [],
        cpuBytes: 0,
        metadata: {
          compileMs: 1,
          vertexCount: 0,
          triangleCount: 0,
          density: 0,
          hasArbitraryTopology: false,
          validationWarnings: 0,
        },
      }),
    ).toBe(false)
    expect(section.pendingCompiled).toBeUndefined()
  })
})

describe('boundary policy', () => {
  it('assigns each shared edge to the lexicographically lower section', () => {
    expect(boundaryOwner({ x: 2, z: 8 }, { x: 3, z: 8 })).toEqual({ x: 2, z: 8 })
    expect(boundaryOwner({ x: -2, z: 7 }, { x: -2, z: 6 })).toEqual({ x: -2, z: 6 })
  })

  it('enumerates only cardinal boundary neighbors', () => {
    expect(cardinalNeighbors({ x: 0, z: 0 })).toEqual([
      { x: 0, z: -1 },
      { x: 1, z: 0 },
      { x: 0, z: 1 },
      { x: -1, z: 0 },
    ])
  })
})
