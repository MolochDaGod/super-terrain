import { describe, expect, it } from 'vitest'
import { createMeshTopology } from './MeshTopology'

describe('mesh topology', () => {
  it('retains ordered neighbour multiplicity across shared edges', () => {
    const topology = createMeshTopology(
      4,
      new Uint32Array([
        0, 1, 2,
        2, 1, 3,
      ]),
    )
    expect([...topology.neighborOffsets]).toEqual([0, 2, 6, 10, 12])
    expect([...topology.neighbors]).toEqual([
      1, 2,
      0, 2, 2, 3,
      1, 0, 1, 3,
      1, 2,
    ])
  })
})
