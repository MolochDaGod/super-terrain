import { describe, expect, it } from 'vitest'
import {
  boundaryOwner,
  buildSectionBoundaryData,
  cardinalNeighbors,
  SECTION_EDGE_MASK,
} from './boundary'
import { EditableMesh } from '../mesh/EditableMesh'
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

  it('installs authoritative source topology with monotonic section revisions', () => {
    const partition = new MeshPartition({ sectionSize: 128, worldSize: 1024, seed: 1 })
    const mesh = new EditableMesh(
      new Float32Array([16, 1, 16, 48, 1, 16, 16, 1, 48]),
      new Uint32Array([0, 2, 1]),
      { sourceId: 'source-a' },
    )
    const section = partition.replaceSourceMesh({ x: 0, z: 0 }, mesh, 100)

    expect(section.revision).toBe(1)
    expect(section.source.procedural).toBe(false)
    expect(partition.editableMeshBytes).toBeGreaterThan(0)
    expect(
      section.source.createCompileSnapshot(section.key, 128),
    ).toMatchObject({ kind: 'editable-mesh', sourceId: 'source-a', revision: 1 })

    partition.restoreProceduralSource(section.key, 101)
    expect(section.revision).toBe(2)
    expect(section.source.procedural).toBe(true)
    expect(partition.editableMeshBytes).toBe(0)
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

  it('gives neighbours identical weld keys and one boundary owner', () => {
    const west = buildSectionBoundaryData(
      new Float32Array([128, 7.25, 40]),
      { x: 0, z: 0 },
      128,
    )
    const east = buildSectionBoundaryData(
      new Float32Array([0, 7.25, 40]),
      { x: 1, z: 0 },
      128,
    )

    expect(west.edgeMasks[0]).toBe(SECTION_EDGE_MASK.east)
    expect(east.edgeMasks[0]).toBe(SECTION_EDGE_MASK.west)
    expect(west.ownedEdgeMasks[0]).toBe(SECTION_EDGE_MASK.east)
    expect(east.ownedEdgeMasks[0]).toBe(0)
    expect([...west.weldKeys]).toEqual([...east.weldKeys])
  })

  it('owns finite-world exterior edges even when no lower neighbour exists', () => {
    const boundary = buildSectionBoundaryData(
      new Float32Array([0, 0, 0]),
      { x: -4, z: -4 },
      128,
      { minSection: -4, maxSection: 3 },
    )
    expect(boundary.ownedEdgeMasks[0]).toBe(
      SECTION_EDGE_MASK.north | SECTION_EDGE_MASK.west,
    )
  })
})
