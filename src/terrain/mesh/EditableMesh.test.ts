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

  it('keeps durable element IDs and attributes through topology patches', () => {
    const mesh = new EditableMesh(squarePositions, squareTriangles, {
      sourceId: 'stable-square',
      vertexIds: new Uint32Array([11, 12, 13, 14]),
      triangleIds: new Uint32Array([21, 22]),
    })
    mesh.setVertexAttribute('weight', new Float32Array([0.1, 0.2, 0.3, 0.4]))
    mesh.setTriangleAttribute('material', new Float32Array([4, 8]))
    mesh.applyPatch({
      removeTriangles: new Uint32Array([0]),
      positions: new Float32Array([0, 1, 0, 1, 1, 0, 0, 1, 1]),
      triangles: new Uint32Array([0, 1, 2]),
      vertexAttributes: new Map([
        ['weight', new Float32Array([0.6, 0.7, 0.8])],
      ]),
      triangleAttributes: new Map([
        ['material', new Float32Array([12])],
      ]),
    })

    expect([...mesh.vertexIds.slice(0, 4)]).toEqual([11, 12, 13, 14])
    expect(new Set(mesh.vertexIds).size).toBe(mesh.vertexCount)
    expect([...mesh.triangleIds]).toEqual([22, 23])
    expect([...mesh.vertexAttributes.get('weight')!]).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
      expect.closeTo(0.4),
      expect.closeTo(0.6),
      expect.closeTo(0.7),
      expect.closeTo(0.8),
    ])
    expect([...mesh.triangleAttributes.get('material')!]).toEqual([8, 12])
    expect(mesh.updateVertexById(11, { x: -1, y: 0, z: 0 })).toBe(true)
    expect(mesh.positions[0]).toBe(-1)
  })

  it('can stitch new topology to retained vertices without duplicating them', () => {
    const mesh = new EditableMesh(squarePositions.slice(), squareTriangles.slice())
    mesh.applyPatch({
      removeTriangles: new Uint32Array([0]),
      positions: new Float32Array([0.5, 1, 0.5]),
      triangles: new Uint32Array([0, 1, 4]),
      triangleIndexSpace: 'combined',
    })

    expect(mesh.vertexCount).toBe(5)
    expect(mesh.triangleCount).toBe(2)
    expect([...mesh.triangles.slice(3)]).toEqual([0, 1, 4])
  })

  it('uses a lazy spatial tree instead of scanning the complete source mesh', () => {
    const mesh = gridMesh(64)
    const stats = { visitedNodes: 0, testedTriangles: 0 }
    const matches = mesh.queryTriangles(
      {
        min: { x: 31.2, y: -1, z: 31.2 },
        max: { x: 32.8, y: 1, z: 32.8 },
      },
      stats,
    )

    expect(matches.length).toBeGreaterThan(0)
    expect([...matches]).toEqual([...matches].sort((a, b) => a - b))
    expect(stats.testedTriangles).toBeLessThan(mesh.triangleCount / 8)
  })

  it('validates closed, wound topology and reports non-manifold edges', () => {
    const tetrahedron = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ])
    const closed = validateMeshData(
      tetrahedron,
      new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
      { boundaryMode: 'closed' },
    )
    expect(closed.valid).toBe(true)
    expect(closed.stats.boundaryEdges).toBe(0)

    const nonManifold = validateMeshData(
      new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, -1, 0,
        0, 0, 1,
      ]),
      new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4]),
    )
    expect(nonManifold.valid).toBe(false)
    expect(nonManifold.stats.nonManifoldEdges).toBe(1)
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

function gridMesh(resolution: number): EditableMesh {
  const positions = new Float32Array((resolution + 1) ** 2 * 3)
  let positionOffset = 0
  for (let z = 0; z <= resolution; z += 1) {
    for (let x = 0; x <= resolution; x += 1) {
      positions[positionOffset++] = x
      positions[positionOffset++] = 0
      positions[positionOffset++] = z
    }
  }
  const triangles = new Uint32Array(resolution * resolution * 6)
  let triangleOffset = 0
  const width = resolution + 1
  for (let z = 0; z < resolution; z += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const a = z * width + x
      const b = a + 1
      const c = a + width
      const d = c + 1
      triangles.set([a, c, b, b, c, d], triangleOffset)
      triangleOffset += 6
    }
  }
  return new EditableMesh(positions, triangles)
}
