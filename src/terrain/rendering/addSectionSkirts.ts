import type { CompiledLOD } from '../core/types'

export interface SkirtedGeometryData {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  surfaceFields: readonly [
    Uint16Array,
    Uint16Array,
    Uint16Array,
    Uint16Array,
    Uint16Array,
  ]
  paintWeights: Uint16Array
  indices: Uint32Array
}

interface EdgeUse {
  a: number
  b: number
  count: number
}

/**
 * Adds a narrow vertical strip only to open edges on a section ownership
 * plane. It hides mixed-LOD chord gaps without changing authoritative terrain
 * topology or adding skirts around intentional tunnel portals.
 */
export function addSectionSkirts(
  lod: Pick<
    CompiledLOD,
    'positions' | 'normals' | 'colors' | 'surfaceFields' | 'paintWeights' | 'indices'
  >,
  sectionSize: number,
): SkirtedGeometryData {
  const sourceSurfaceFields =
    lod.surfaceFields ?? createDefaultSurfaceFields(lod.positions.length / 3)
  const sourcePaintWeights =
    lod.paintWeights ?? new Uint16Array((lod.positions.length / 3) * 4)
  const edges = collectOpenEdges(lod.indices)
  const candidates = edges
    .map((edge) => ({ edge, normal: ownershipPlaneNormal(lod.positions, edge, sectionSize) }))
    .filter((candidate): candidate is { edge: EdgeUse; normal: readonly [number, number, number] } =>
      candidate.normal !== undefined,
    )
  if (candidates.length === 0) {
    return {
      ...lod,
      surfaceFields: sourceSurfaceFields,
      paintWeights: sourcePaintWeights,
    }
  }

  const positions = Array.from(lod.positions)
  const normals = Array.from(lod.normals)
  const colors = Array.from(lod.colors)
  const surfaceFields = sourceSurfaceFields.map((field) => Array.from(field)) as [
    number[],
    number[],
    number[],
    number[],
    number[],
  ]
  const paintWeights = Array.from(sourcePaintWeights)
  const indices = Array.from(lod.indices)
  const skirtDepth = Math.max(1.5, sectionSize / 32)

  for (const { edge, normal } of candidates) {
    const first = edge.a * 3
    const second = edge.b * 3
    const base = positions.length / 3
    appendVertex(positions, normals, colors, surfaceFields, paintWeights, lod, sourceSurfaceFields, sourcePaintWeights, first, normal, 0)
    appendVertex(positions, normals, colors, surfaceFields, paintWeights, lod, sourceSurfaceFields, sourcePaintWeights, first, normal, -skirtDepth)
    appendVertex(positions, normals, colors, surfaceFields, paintWeights, lod, sourceSurfaceFields, sourcePaintWeights, second, normal, 0)
    appendVertex(positions, normals, colors, surfaceFields, paintWeights, lod, sourceSurfaceFields, sourcePaintWeights, second, normal, -skirtDepth)
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3)
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Float32Array.from(colors),
    surfaceFields: surfaceFields.map((field) => Uint16Array.from(field)) as [
      Uint16Array,
      Uint16Array,
      Uint16Array,
      Uint16Array,
      Uint16Array,
    ],
    paintWeights: Uint16Array.from(paintWeights),
    indices: Uint32Array.from(indices),
  }
}

function appendVertex(
  positions: number[],
  normals: number[],
  colors: number[],
  surfaceFields: [number[], number[], number[], number[], number[]],
  paintWeights: number[],
  source: Pick<CompiledLOD, 'positions' | 'colors'>,
  sourceSurfaceFields: readonly [
    Uint16Array,
    Uint16Array,
    Uint16Array,
    Uint16Array,
    Uint16Array,
  ],
  sourcePaintWeights: Uint16Array,
  offset: number,
  normal: readonly [number, number, number],
  yOffset: number,
): void {
  positions.push(
    source.positions[offset],
    source.positions[offset + 1] + yOffset,
    source.positions[offset + 2],
  )
  normals.push(normal[0], normal[1], normal[2])
  colors.push(
    source.colors[offset],
    source.colors[offset + 1],
    source.colors[offset + 2],
  )
  const vertex = offset / 3
  const fieldOffset = vertex * 4
  for (let field = 0; field < surfaceFields.length; field += 1) {
    surfaceFields[field].push(
      sourceSurfaceFields[field][fieldOffset],
      sourceSurfaceFields[field][fieldOffset + 1],
      sourceSurfaceFields[field][fieldOffset + 2],
      sourceSurfaceFields[field][fieldOffset + 3],
    )
  }
  paintWeights.push(
    sourcePaintWeights[fieldOffset],
    sourcePaintWeights[fieldOffset + 1],
    sourcePaintWeights[fieldOffset + 2],
    sourcePaintWeights[fieldOffset + 3],
  )
}

function createDefaultSurfaceFields(vertexCount: number): readonly [
  Uint16Array,
  Uint16Array,
  Uint16Array,
  Uint16Array,
  Uint16Array,
] {
  const fields: [Uint16Array, Uint16Array, Uint16Array, Uint16Array, Uint16Array] = [
    new Uint16Array(vertexCount * 4),
    new Uint16Array(vertexCount * 4),
    new Uint16Array(vertexCount * 4),
    new Uint16Array(vertexCount * 4),
    new Uint16Array(vertexCount * 4),
  ]
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 4
    for (let field = 0; field < fields.length; field += 1) {
      fields[field][offset] = 32_768
      fields[field][offset + 1] = 32_768
      fields[field][offset + 2] = 32_768
      fields[field][offset + 3] = 32_768
    }
    fields[0][offset] = 0x8080
    fields[0][offset + 1] = 0x8080
    fields[0][offset + 2] = 0x8080
    fields[2][offset + 1] = 0x8080
    fields[4][offset + 1] = 65_535
  }
  return fields
}

function collectOpenEdges(indices: Uint32Array): EdgeUse[] {
  const edges = new Map<string, EdgeUse>()
  for (let offset = 0; offset < indices.length; offset += 3) {
    addEdge(edges, indices[offset], indices[offset + 1])
    addEdge(edges, indices[offset + 1], indices[offset + 2])
    addEdge(edges, indices[offset + 2], indices[offset])
  }
  return [...edges.values()].filter((edge) => edge.count === 1)
}

function addEdge(edges: Map<string, EdgeUse>, a: number, b: number): void {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`
  const current = edges.get(key)
  if (current) current.count += 1
  else edges.set(key, { a, b, count: 1 })
}

function ownershipPlaneNormal(
  positions: Float32Array,
  edge: EdgeUse,
  sectionSize: number,
): readonly [number, number, number] | undefined {
  const a = edge.a * 3
  const b = edge.b * 3
  const epsilon = Math.max(0.002, sectionSize * 2e-5)
  if (near(positions[a], 0, epsilon) && near(positions[b], 0, epsilon)) {
    return [-1, 0, 0]
  }
  if (
    near(positions[a], sectionSize, epsilon) &&
    near(positions[b], sectionSize, epsilon)
  ) {
    return [1, 0, 0]
  }
  if (near(positions[a + 2], 0, epsilon) && near(positions[b + 2], 0, epsilon)) {
    return [0, 0, -1]
  }
  if (
    near(positions[a + 2], sectionSize, epsilon) &&
    near(positions[b + 2], sectionSize, epsilon)
  ) {
    return [0, 0, 1]
  }
  return undefined
}

function near(value: number, target: number, epsilon: number): boolean {
  return Math.abs(value - target) <= epsilon
}
