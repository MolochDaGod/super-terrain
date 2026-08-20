import { describe, expect, it } from 'vitest'
import { validateMeshData } from '../../mesh/MeshValidation'
import {
  removeBooleanSliverTriangles,
  type BooleanMeshBuffers,
} from './MeshBooleanBackend'

describe('mesh boolean cleanup', () => {
  it('drops numerical shards that the authoritative validator rejects', () => {
    const buffers: BooleanMeshBuffers = {
      positions: new Float32Array([
        0, 0, 0,
        1e-7, 0, 0,
        0, 1e-7, 0,
        0, 0, 0,
        2, 0, 0,
        0, 2, 0,
      ]),
      normals: new Float32Array(18),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      interiorVertices: new Uint8Array(6),
    }

    expect(
      validateMeshData(buffers.positions, buffers.indices, {
        rejectDegenerateTriangles: true,
      }).valid,
    ).toBe(false)
    const cleaned = removeBooleanSliverTriangles(buffers)
    expect([...cleaned.indices]).toEqual([3, 4, 5])
    expect(
      validateMeshData(cleaned.positions, cleaned.indices, {
        rejectDegenerateTriangles: true,
      }).valid,
    ).toBe(true)
  })
})

describe('needle removal', () => {
  it('drops long thin shards but keeps ordinary grid triangles', () => {
    const buffers = {
      positions: Float32Array.from([
        // A needle: eight metres long, two centimetres wide.
        0, 0, 0, 8, 0, 0, 4, 0.02, 0,
        // An ordinary half-quad from a 1.3 m grid.
        0, 0, 10, 1.3, 0, 10, 0, 0, 11.3,
        // A short thin triangle along a seam: legitimate, and kept.
        0, 0, 20, 1.2, 0, 20, 0.6, 0.01, 20,
      ]),
      normals: new Float32Array(27),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      interiorVertices: new Uint8Array(9),
    }
    const cleaned = removeBooleanSliverTriangles(buffers)
    expect(Array.from(cleaned.indices)).toEqual([3, 4, 5, 6, 7, 8])
  })
})
