import type { AABB } from '../core/types'
import { validateMeshData } from './MeshValidation'

export interface EditableMeshSnapshot {
  positions: Float32Array
  triangles: Uint32Array
  vertexAttributes: ReadonlyMap<string, Float32Array>
  triangleAttributes: ReadonlyMap<string, Float32Array>
}

export interface MeshPatch {
  positions: Float32Array
  triangles: Uint32Array
  removeTriangles?: Uint32Array
}

interface AdjacencyData {
  vertexOffsets: Uint32Array
  vertexNeighbors: Uint32Array
  triangleOffsets: Uint32Array
  triangleNeighbors: Uint32Array
  boundaryVertices: Uint8Array
}

export class EditableMesh {
  positions: Float32Array
  triangles: Uint32Array
  readonly vertexAttributes = new Map<string, Float32Array>()
  readonly triangleAttributes = new Map<string, Float32Array>()
  private adjacency?: AdjacencyData

  constructor(positions = new Float32Array(), triangles = new Uint32Array()) {
    this.positions = positions
    this.triangles = triangles
    const validation = validateMeshData(positions, triangles)
    if (!validation.valid) throw new Error(validation.errors.join('; '))
  }

  get vertexCount(): number {
    return this.positions.length / 3
  }

  get triangleCount(): number {
    return this.triangles.length / 3
  }

  get byteLength(): number {
    let bytes = this.positions.byteLength + this.triangles.byteLength
    for (const value of this.vertexAttributes.values()) bytes += value.byteLength
    for (const value of this.triangleAttributes.values()) bytes += value.byteLength
    return bytes
  }

  setVertexAttribute(name: string, values: Float32Array): void {
    if (values.length % this.vertexCount !== 0) {
      throw new Error(`Vertex attribute ${name} does not match the vertex count`)
    }
    this.vertexAttributes.set(name, values)
  }

  setTriangleAttribute(name: string, values: Float32Array): void {
    if (values.length % this.triangleCount !== 0) {
      throw new Error(`Triangle attribute ${name} does not match the triangle count`)
    }
    this.triangleAttributes.set(name, values)
  }

  getVertexNeighbors(vertex: number): Uint32Array {
    const adjacency = this.getAdjacency()
    return adjacency.vertexNeighbors.slice(
      adjacency.vertexOffsets[vertex],
      adjacency.vertexOffsets[vertex + 1],
    )
  }

  getTriangleNeighbors(triangle: number): Uint32Array {
    const adjacency = this.getAdjacency()
    return adjacency.triangleNeighbors.slice(
      adjacency.triangleOffsets[triangle],
      adjacency.triangleOffsets[triangle + 1],
    )
  }

  isBoundaryVertex(vertex: number): boolean {
    return this.getAdjacency().boundaryVertices[vertex] === 1
  }

  queryTriangles(bounds: AABB): Uint32Array {
    const matches: number[] = []
    for (let triangle = 0; triangle < this.triangleCount; triangle += 1) {
      const offset = triangle * 3
      let minX = Infinity
      let minY = Infinity
      let minZ = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let maxZ = -Infinity
      for (let corner = 0; corner < 3; corner += 1) {
        const position = this.triangles[offset + corner] * 3
        const x = this.positions[position]
        const y = this.positions[position + 1]
        const z = this.positions[position + 2]
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        minZ = Math.min(minZ, z)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
        maxZ = Math.max(maxZ, z)
      }
      if (
        maxX >= bounds.min.x &&
        minX <= bounds.max.x &&
        maxY >= bounds.min.y &&
        minY <= bounds.max.y &&
        maxZ >= bounds.min.z &&
        minZ <= bounds.max.z
      ) {
        matches.push(triangle)
      }
    }
    return Uint32Array.from(matches)
  }

  extractRegion(bounds: AABB): EditableMesh {
    const selectedTriangles = this.queryTriangles(bounds)
    const vertexMap = new Map<number, number>()
    const positions: number[] = []
    const triangles: number[] = []

    for (const triangle of selectedTriangles) {
      for (let corner = 0; corner < 3; corner += 1) {
        const sourceVertex = this.triangles[triangle * 3 + corner]
        let targetVertex = vertexMap.get(sourceVertex)
        if (targetVertex === undefined) {
          targetVertex = vertexMap.size
          vertexMap.set(sourceVertex, targetVertex)
          const sourcePosition = sourceVertex * 3
          positions.push(
            this.positions[sourcePosition],
            this.positions[sourcePosition + 1],
            this.positions[sourcePosition + 2],
          )
        }
        triangles.push(targetVertex)
      }
    }

    return new EditableMesh(Float32Array.from(positions), Uint32Array.from(triangles))
  }

  applyPatch(patch: MeshPatch): void {
    const removed = new Set(patch.removeTriangles ?? [])
    const retained: number[] = []
    for (let triangle = 0; triangle < this.triangleCount; triangle += 1) {
      if (removed.has(triangle)) continue
      const offset = triangle * 3
      retained.push(
        this.triangles[offset],
        this.triangles[offset + 1],
        this.triangles[offset + 2],
      )
    }

    const vertexOffset = this.vertexCount
    const nextPositions = new Float32Array(this.positions.length + patch.positions.length)
    nextPositions.set(this.positions)
    nextPositions.set(patch.positions, this.positions.length)
    const nextTriangles = new Uint32Array(retained.length + patch.triangles.length)
    nextTriangles.set(retained)
    for (let index = 0; index < patch.triangles.length; index += 1) {
      nextTriangles[retained.length + index] = patch.triangles[index] + vertexOffset
    }

    this.positions = nextPositions
    this.triangles = nextTriangles
    this.vertexAttributes.clear()
    this.triangleAttributes.clear()
    this.adjacency = undefined
  }

  snapshot(): EditableMeshSnapshot {
    return {
      positions: this.positions,
      triangles: this.triangles,
      vertexAttributes: this.vertexAttributes,
      triangleAttributes: this.triangleAttributes,
    }
  }

  clone(): EditableMesh {
    const copy = new EditableMesh(this.positions.slice(), this.triangles.slice())
    for (const [name, values] of this.vertexAttributes) {
      copy.vertexAttributes.set(name, values.slice())
    }
    for (const [name, values] of this.triangleAttributes) {
      copy.triangleAttributes.set(name, values.slice())
    }
    return copy
  }

  private getAdjacency(): AdjacencyData {
    this.adjacency ??= buildAdjacency(this.vertexCount, this.triangles)
    return this.adjacency
  }
}

function buildAdjacency(vertexCount: number, triangles: Uint32Array): AdjacencyData {
  const vertexSets = Array.from({ length: vertexCount }, () => new Set<number>())
  const triangleSets = Array.from(
    { length: triangles.length / 3 },
    () => new Set<number>(),
  )
  const edgeTriangles = new Map<string, number[]>()

  for (let triangle = 0; triangle < triangles.length / 3; triangle += 1) {
    const a = triangles[triangle * 3]
    const b = triangles[triangle * 3 + 1]
    const c = triangles[triangle * 3 + 2]
    vertexSets[a].add(b).add(c)
    vertexSets[b].add(a).add(c)
    vertexSets[c].add(a).add(b)
    addEdge(edgeTriangles, a, b, triangle)
    addEdge(edgeTriangles, b, c, triangle)
    addEdge(edgeTriangles, c, a, triangle)
  }

  const boundaryVertices = new Uint8Array(vertexCount)
  for (const [edge, owners] of edgeTriangles) {
    if (owners.length === 1) {
      const [a, b] = edge.split(':').map(Number)
      boundaryVertices[a] = 1
      boundaryVertices[b] = 1
    } else {
      for (const owner of owners) {
        for (const neighbor of owners) {
          if (owner !== neighbor) triangleSets[owner].add(neighbor)
        }
      }
    }
  }

  const vertexPacked = packSets(vertexSets)
  const trianglePacked = packSets(triangleSets)
  return {
    vertexOffsets: vertexPacked.offsets,
    vertexNeighbors: vertexPacked.values,
    triangleOffsets: trianglePacked.offsets,
    triangleNeighbors: trianglePacked.values,
    boundaryVertices,
  }
}

function addEdge(
  edges: Map<string, number[]>,
  a: number,
  b: number,
  triangle: number,
): void {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`
  const owners = edges.get(key)
  if (owners) owners.push(triangle)
  else edges.set(key, [triangle])
}

function packSets(sets: Set<number>[]): { offsets: Uint32Array; values: Uint32Array } {
  const offsets = new Uint32Array(sets.length + 1)
  let valueCount = 0
  for (let index = 0; index < sets.length; index += 1) {
    valueCount += sets[index].size
    offsets[index + 1] = valueCount
  }
  const values = new Uint32Array(valueCount)
  let cursor = 0
  for (const set of sets) {
    for (const value of set) values[cursor++] = value
  }
  return { offsets, values }
}

export class EditableMeshSection {
  mesh?: EditableMesh
  appliedRevision = -1
  readonly seed: number
  readonly procedural: boolean

  constructor(seed: number, procedural = true) {
    this.seed = seed
    this.procedural = procedural
  }

  replaceMesh(mesh: EditableMesh, revision: number): void {
    if (revision < this.appliedRevision) return
    this.mesh = mesh
    this.appliedRevision = revision
  }

  get byteLength(): number {
    return this.mesh?.byteLength ?? 0
  }
}
