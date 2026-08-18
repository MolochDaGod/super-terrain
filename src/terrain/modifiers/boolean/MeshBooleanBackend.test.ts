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
