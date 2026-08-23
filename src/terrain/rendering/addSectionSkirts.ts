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

type SourceLod = Pick<
  CompiledLOD,
  'positions' | 'normals' | 'colors' | 'surfaceFields' | 'paintWeights' | 'indices'
>

/** One vertical face: the source edge it hangs from and the plane it faces. */
interface SkirtCandidate {
  a: number
  b: number
  normalX: number
  normalY: number
  normalZ: number
}

/**
 * Adds a narrow vertical strip only to open edges on a section ownership
 * plane. It hides mixed-LOD chord gaps without changing authoritative terrain
 * topology or adding skirts around intentional tunnel portals.
 *
 * This runs on the main thread inside the frame that installs a section, so it
 * is written as typed-array copies throughout. The previous implementation
 * unpacked every stream into a plain `number[]` with `Array.from`, pushed the
 * skirt onto the end and converted the whole thing back: for one LOD0 section
 * that boxed roughly 330,000 elements twice over in order to append about 700
 * vertices, and it cost 30-70 ms per section on its own. The output arrays here
 * are sized exactly up front and filled with `set`, so the source streams move
 * at memcpy speed and only the appended tail is written element by element.
 */
export function addSectionSkirts(
  lod: SourceLod,
  sectionSize: number,
): SkirtedGeometryData {
  const vertexCount = lod.positions.length / 3
  const sourceSurfaceFields = lod.surfaceFields ?? createDefaultSurfaceFields(vertexCount)
  const sourcePaintWeights = lod.paintWeights ?? new Uint16Array(vertexCount * 4)
  const candidates = collectSkirtCandidates(lod, sectionSize)
  if (candidates.length === 0) {
    return {
      ...lod,
      surfaceFields: sourceSurfaceFields,
      paintWeights: sourcePaintWeights,
    }
  }

  const skirtVertices = candidates.length * 4
  const totalVertices = vertexCount + skirtVertices
  const positions = new Float32Array(totalVertices * 3)
  const normals = new Float32Array(totalVertices * 3)
  const colors = new Float32Array(totalVertices * 3)
  const paintWeights = new Uint16Array(totalVertices * 4)
  const surfaceFields = sourceSurfaceFields.map((field) => {
    const target = new Uint16Array(totalVertices * 4)
    target.set(field)
    return target
  }) as unknown as [Uint16Array, Uint16Array, Uint16Array, Uint16Array, Uint16Array]
  positions.set(lod.positions)
  normals.set(lod.normals)
  colors.set(lod.colors)
  paintWeights.set(sourcePaintWeights)

  const indices = new Uint32Array(lod.indices.length + candidates.length * 6)
  indices.set(lod.indices)

  const skirtDepth = Math.max(1.5, sectionSize / 32)
  let vertex = vertexCount
  let index = lod.indices.length
  for (const candidate of candidates) {
    const base = vertex
    // Top and bottom of each end, in the order the two triangles below expect.
    vertex = appendSkirtVertex(
      candidate.a, 0, vertex, candidate,
      positions, normals, colors, surfaceFields, paintWeights,
      lod, sourceSurfaceFields, sourcePaintWeights,
    )
    vertex = appendSkirtVertex(
      candidate.a, -skirtDepth, vertex, candidate,
      positions, normals, colors, surfaceFields, paintWeights,
      lod, sourceSurfaceFields, sourcePaintWeights,
    )
    vertex = appendSkirtVertex(
      candidate.b, 0, vertex, candidate,
      positions, normals, colors, surfaceFields, paintWeights,
      lod, sourceSurfaceFields, sourcePaintWeights,
    )
    vertex = appendSkirtVertex(
      candidate.b, -skirtDepth, vertex, candidate,
      positions, normals, colors, surfaceFields, paintWeights,
      lod, sourceSurfaceFields, sourcePaintWeights,
    )
    indices[index] = base
    indices[index + 1] = base + 1
    indices[index + 2] = base + 2
    indices[index + 3] = base + 2
    indices[index + 4] = base + 1
    indices[index + 5] = base + 3
    index += 6
  }

  return { positions, normals, colors, surfaceFields, paintWeights, indices }
}

function appendSkirtVertex(
  sourceVertex: number,
  yOffset: number,
  targetVertex: number,
  candidate: SkirtCandidate,
  positions: Float32Array,
  normals: Float32Array,
  colors: Float32Array,
  surfaceFields: readonly Uint16Array[],
  paintWeights: Uint16Array,
  lod: Pick<SourceLod, 'positions' | 'colors'>,
  sourceSurfaceFields: readonly Uint16Array[],
  sourcePaintWeights: Uint16Array,
): number {
  const source = sourceVertex * 3
  const target = targetVertex * 3
  positions[target] = lod.positions[source]
  positions[target + 1] = lod.positions[source + 1] + yOffset
  positions[target + 2] = lod.positions[source + 2]
  normals[target] = candidate.normalX
  normals[target + 1] = candidate.normalY
  normals[target + 2] = candidate.normalZ
  colors[target] = lod.colors[source]
  colors[target + 1] = lod.colors[source + 1]
  colors[target + 2] = lod.colors[source + 2]

  const sourceField = sourceVertex * 4
  const targetField = targetVertex * 4
  for (let field = 0; field < surfaceFields.length; field += 1) {
    const from = sourceSurfaceFields[field]
    const to = surfaceFields[field]
    to[targetField] = from[sourceField]
    to[targetField + 1] = from[sourceField + 1]
    to[targetField + 2] = from[sourceField + 2]
    to[targetField + 3] = from[sourceField + 3]
  }
  paintWeights[targetField] = sourcePaintWeights[sourceField]
  paintWeights[targetField + 1] = sourcePaintWeights[sourceField + 1]
  paintWeights[targetField + 2] = sourcePaintWeights[sourceField + 2]
  paintWeights[targetField + 3] = sourcePaintWeights[sourceField + 3]
  return targetVertex + 1
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

/** Outward normals of the four ownership planes, indexed by `planeOf`. */
const PLANE_NORMALS: readonly (readonly [number, number, number])[] = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, 0, -1],
  [0, 0, 1],
]

/**
 * Open edges that lie on an ownership plane, in the order they are met.
 *
 * Edge identity is a single number rather than an `a:b` string. A LOD0 section
 * offers around 46,000 edges, so the old key built that many strings and an
 * accumulator object apiece purely to find the few hundred that turn out to be
 * open.
 *
 * The plane test comes before the tally rather than after it. An edge that does
 * not lie on a section boundary cannot become a skirt however many triangles
 * share it, and there are two orders of magnitude more of those than there are
 * candidates, so testing four float comparisons first keeps the map down to the
 * boundary ring instead of the whole mesh.
 *
 * The tally packs two things into its value: the use count in the high bits and,
 * in bit 0, whether the edge was first met running against its sorted key. The
 * skirt copies its four corners from the two endpoints in order, so an edge
 * quoted back the other way round would hang the face off the wrong vertices
 * and wind it backwards. Only the orientation of the *first* sighting is kept,
 * which is what an edge's owning triangle gives it.
 */
function collectSkirtCandidates(
  lod: SourceLod,
  sectionSize: number,
): SkirtCandidate[] {
  const { indices, positions } = lod
  const vertexCount = positions.length / 3
  const epsilon = Math.max(0.002, sectionSize * 2e-5)
  const uses = new Map<number, number>()
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]
    const b = indices[offset + 1]
    const c = indices[offset + 2]
    countEdge(uses, positions, a, b, vertexCount, sectionSize, epsilon)
    countEdge(uses, positions, b, c, vertexCount, sectionSize, epsilon)
    countEdge(uses, positions, c, a, vertexCount, sectionSize, epsilon)
  }

  const candidates: SkirtCandidate[] = []
  for (const [key, use] of uses) {
    if (use >> 1 !== 1) continue
    const low = Math.floor(key / vertexCount)
    const high = key - low * vertexCount
    const reversed = (use & 1) === 1
    const a = reversed ? high : low
    const b = reversed ? low : high
    const normal = PLANE_NORMALS[planeOf(positions, a, b, sectionSize, epsilon)]
    candidates.push({
      a,
      b,
      normalX: normal[0],
      normalY: normal[1],
      normalZ: normal[2],
    })
  }
  return candidates
}

function countEdge(
  uses: Map<number, number>,
  positions: Float32Array,
  a: number,
  b: number,
  vertexCount: number,
  sectionSize: number,
  epsilon: number,
): void {
  if (planeOf(positions, a, b, sectionSize, epsilon) < 0) return
  const ascending = a < b
  const key = ascending ? a * vertexCount + b : b * vertexCount + a
  const existing = uses.get(key)
  if (existing === undefined) uses.set(key, 2 + (ascending ? 0 : 1))
  else uses.set(key, existing + 2)
}

/** Index into `PLANE_NORMALS`, or -1 when the edge is interior. */
function planeOf(
  positions: Float32Array,
  edgeA: number,
  edgeB: number,
  sectionSize: number,
  epsilon: number,
): number {
  const a = edgeA * 3
  const b = edgeB * 3
  if (near(positions[a], 0, epsilon) && near(positions[b], 0, epsilon)) return 0
  if (
    near(positions[a], sectionSize, epsilon) &&
    near(positions[b], sectionSize, epsilon)
  ) {
    return 1
  }
  if (near(positions[a + 2], 0, epsilon) && near(positions[b + 2], 0, epsilon)) {
    return 2
  }
  if (
    near(positions[a + 2], sectionSize, epsilon) &&
    near(positions[b + 2], sectionSize, epsilon)
  ) {
    return 3
  }
  return -1
}

function near(value: number, target: number, epsilon: number): boolean {
  return Math.abs(value - target) <= epsilon
}
