import { describe, expect, it } from 'vitest'
import { dropDegenerateTriangles, validateMeshData } from './MeshValidation'

describe('degenerate triangle repair', () => {
  it('drops zero-area triangles so a compile survives them', () => {
    // Two vertices pulled onto each other, which is what a fold does at the
    // moment it crosses. The section used to be rejected outright for this.
    const positions = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 0, 1,
      1, 0, 0,
    ])
    const indices = new Uint32Array([0, 2, 1, 1, 2, 3])
    expect(
      validateMeshData(positions, indices, { rejectDegenerateTriangles: true }).valid,
    ).toBe(false)

    const repaired = dropDegenerateTriangles(positions, indices)
    expect(repaired.dropped).toBe(1)
    expect(Array.from(repaired.indices)).toEqual([0, 2, 1])
    expect(
      validateMeshData(positions, repaired.indices, {
        rejectDegenerateTriangles: true,
      }).valid,
    ).toBe(true)
  })

  it('leaves a sound mesh untouched, returning the original buffer', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1])
    const indices = new Uint32Array([0, 2, 1])
    const repaired = dropDegenerateTriangles(positions, indices)
    expect(repaired.dropped).toBe(0)
    expect(repaired.indices).toBe(indices)
  })
})
