import { describe, expect, it } from 'vitest'
import { EditableMesh } from './EditableMesh'
import { validateMeshData } from './MeshValidation'

const squarePositions = new Float32Array([
  0, 0, 0,
  1, 0, 0,
  1, 0, 1,
  0, 0, 1,
])
const squareTriangles = new Uint32Array([0, 2, 1, 0, 3, 2])

describe('editable mesh', () => {
  it('builds compact adjacency and boundary flags', () => {
    const mesh = new EditableMesh(squarePositions, squareTriangles)
    expect([...mesh.getVertexNeighbors(0)].sort()).toEqual([1, 2, 3])
    expect([...mesh.getTriangleNeighbors(0)]).toEqual([1])
    expect(mesh.isBoundaryVertex(0)).toBe(true)
  })

  it('extracts intersecting topology and applies indexed patches', () => {
    const mesh = new EditableMesh(squarePositions, squareTriangles)
    const region = mesh.extractRegion({
      min: { x: -0.1, y: -1, z: -0.1 },
      max: { x: 0.6, y: 1, z: 0.6 },
    })
    expect(region.triangleCount).toBe(2)
    mesh.applyPatch({
      removeTriangles: new Uint32Array([0]),
      positions: new Float32Array([0, 1, 0, 1, 1, 0, 0, 1, 1]),
      triangles: new Uint32Array([0, 1, 2]),
    })
    expect(mesh.triangleCount).toBe(2)
    expect(mesh.vertexCount).toBe(7)
  })

  it('reports invalid indices and non-finite positions', () => {
    const validation = validateMeshData(
      new Float32Array([0, Number.NaN, 0]),
      new Uint32Array([0, 1, 2]),
    )
    expect(validation.valid).toBe(false)
    expect(validation.errors.length).toBeGreaterThanOrEqual(2)
  })
})
