/**
 * Compact, allocation-free-to-traverse topology shared by mesh analysis.
 *
 * Neighbours retain triangle incidence multiplicity. That is deliberate: the
 * compiler's diffusion fields weight an interior edge once for each owning
 * triangle, and changing that weighting would change the authored materials.
 */
export interface MeshTopology {
  readonly vertexCount: number
  /** CSR offsets into `neighbors`; every vertex range has an even length. */
  readonly neighborOffsets: Uint32Array
  /** Two neighbours per incident triangle, in source triangle order. */
  readonly neighbors: Uint32Array
}

export function createMeshTopology(
  vertexCount: number,
  indices: Uint32Array,
): MeshTopology {
  const neighborOffsets = new Uint32Array(vertexCount + 1)
  for (let offset = 0; offset < indices.length; offset += 3) {
    neighborOffsets[indices[offset] + 1] += 2
    neighborOffsets[indices[offset + 1] + 1] += 2
    neighborOffsets[indices[offset + 2] + 1] += 2
  }
  for (let vertex = 1; vertex < neighborOffsets.length; vertex += 1) {
    neighborOffsets[vertex] += neighborOffsets[vertex - 1]
  }

  const neighbors = new Uint32Array(neighborOffsets[vertexCount])
  const cursors = neighborOffsets.slice(0, vertexCount)
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]
    const b = indices[offset + 1]
    const c = indices[offset + 2]
    appendPair(neighbors, cursors, a, b, c)
    // This order matches the scalar curvature traversal. Occlusion consumes
    // each adjacent pair as a sum, for which the reversed pair is identical.
    appendPair(neighbors, cursors, b, a, c)
    appendPair(neighbors, cursors, c, b, a)
  }
  return { vertexCount, neighborOffsets, neighbors }
}

function appendPair(
  neighbors: Uint32Array,
  cursors: Uint32Array,
  vertex: number,
  first: number,
  second: number,
): void {
  const cursor = cursors[vertex]
  neighbors[cursor] = first
  neighbors[cursor + 1] = second
  cursors[vertex] = cursor + 2
}
