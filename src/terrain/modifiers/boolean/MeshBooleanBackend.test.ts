import { describe, expect, it } from 'vitest'
import { validateMeshData } from '../../mesh/MeshValidation'
import {
  BvhCsgTunnelBooleanBackend,
  PATCH_SURFACE_TRIANGLE,
  removeBooleanSliverTriangles,
  smoothBooleanJunctionNormals,
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

describe('additive patch integration', () => {
  it('retains triangle provenance through exact CSG', () => {
    const backend = new BvhCsgTunnelBooleanBackend()
    const target: BooleanMeshBuffers = {
      positions: Float32Array.from([
        0, 0, 0,
        16, 0, 0,
        0, 0, 16,
        16, 0, 16,
      ]),
      normals: Float32Array.from([
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
      ]),
      indices: Uint32Array.from([0, 2, 1, 1, 2, 3]),
      interiorVertices: new Uint8Array(4),
    }
    const result = backend.evaluate(
      target,
      [{
        operation: 'add',
        cutters: [{
          kind: 'ellipsoid',
          center: { x: 8, y: 1, z: 8 },
          radii: { x: 3, y: 3, z: 3 },
          forward: { x: 1, y: 0, z: 0 },
          surface: 'none',
        }],
      }],
      0,
      0,
      16,
      0.25,
      17,
    )

    expect(result.triangleSurfaceKinds).toBeDefined()
    expect(result.triangleSurfaceKinds).toContain(PATCH_SURFACE_TRIANGLE)
    expect(result.triangleSurfaceKinds).toContain(0)
  })

  it('matches normals across duplicated terrain/patch junction vertices', () => {
    const result = smoothBooleanJunctionNormals({
      positions: Float32Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 0, 1,
        // CSG material split duplicates the two intersection vertices.
        1, 0, 0,
        0, 0, 1,
        0.5, 1, 0.5,
      ]),
      normals: Float32Array.from([
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
        0, 0, -1,
        0, 0, -1,
        0, 0, -1,
      ]),
      indices: Uint32Array.from([0, 2, 1, 3, 4, 5]),
      interiorVertices: new Uint8Array(6),
      triangleSurfaceKinds: Uint8Array.from([0, PATCH_SURFACE_TRIANGLE]),
    })

    expect(Array.from(result.normals.slice(3, 6))).toEqual(
      Array.from(result.normals.slice(9, 12)),
    )
    expect(Array.from(result.normals.slice(6, 9))).toEqual(
      Array.from(result.normals.slice(12, 15)),
    )
    // A fracture vertex away from the junction keeps its authored normal.
    expect(Array.from(result.normals.slice(15, 18))).toEqual([0, 0, -1])
  })
})
