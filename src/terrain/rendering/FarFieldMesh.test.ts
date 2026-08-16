import { describe, expect, it } from 'vitest'
import { generateFarFieldMesh } from './FarFieldMesh'

describe('far-field terrain mesh', () => {
  it('builds a finite elevated world proxy with upward normals', () => {
    const mesh = generateFarFieldMesh(16_384, 13_371)
    expect(mesh.positions.length / 3).toBe(97 * 97)
    expect(mesh.indices.length / 3).toBe(96 * 96 * 2)
    expect(mesh.positions.every(Number.isFinite)).toBe(true)
    expect(mesh.normals.every(Number.isFinite)).toBe(true)
    let upward = 0
    for (let offset = 1; offset < mesh.normals.length; offset += 3) {
      if (mesh.normals[offset] > 0) upward += 1
    }
    expect(upward).toBe(mesh.normals.length / 3)
  })
})
