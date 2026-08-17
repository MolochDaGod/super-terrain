export type MeshBoundaryMode = 'allow' | 'closed' | 'section'

export interface MeshValidationOptions {
  boundaryMode?: MeshBoundaryMode
  sectionSize?: number
  boundaryEpsilon?: number
  minimumDoubleAreaSquared?: number
  rejectDegenerateTriangles?: boolean
  checkWinding?: boolean
}

export interface MeshValidationStats {
  boundaryEdges: number
  nonManifoldEdges: number
  inconsistentWindingEdges: number
  degenerateTriangles: number
}

export interface MeshValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  stats: MeshValidationStats
}

interface EdgeUse {
  a: number
  b: number
  count: number
  inconsistent: boolean
}

const MAX_DETAILS = 32

export function validateMeshData(
  positions: Float32Array,
  indices: Uint32Array,
  options: MeshValidationOptions = {},
): MeshValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const stats: MeshValidationStats = {
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    inconsistentWindingEdges: 0,
    degenerateTriangles: 0,
  }
  const vertexCount = positions.length / 3
  const alignedPositions = positions.length % 3 === 0
  const alignedIndices = indices.length % 3 === 0

  if (!alignedPositions) errors.push('Position data is not xyz-aligned')
  if (!alignedIndices) errors.push('Index data is not triangle-aligned')

  for (let index = 0; index < positions.length; index += 1) {
    if (!Number.isFinite(positions[index])) {
      errors.push(`Position component ${index} is not finite`)
      if (errors.length >= MAX_DETAILS) break
    }
  }

  let indicesInRange = alignedPositions
  for (let index = 0; index < indices.length; index += 1) {
    if (indices[index] >= vertexCount) {
      errors.push(`Triangle index ${indices[index]} exceeds vertex count`)
      indicesInRange = false
      if (errors.length >= MAX_DETAILS) break
    }
  }

  if (!alignedIndices || !indicesInRange) {
    return { valid: false, errors, warnings, stats }
  }

  const edgeUses = new Map<number, EdgeUse>()
  const minimumArea = options.minimumDoubleAreaSquared ?? 1e-12
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = offset / 3
    const aIndex = indices[offset]
    const bIndex = indices[offset + 1]
    const cIndex = indices[offset + 2]
    if (aIndex === bIndex || bIndex === cIndex || cIndex === aIndex) {
      errors.push(`Triangle ${triangle} repeats a vertex index`)
      stats.degenerateTriangles += 1
      if (errors.length >= MAX_DETAILS) break
      continue
    }

    const a = aIndex * 3
    const b = bIndex * 3
    const c = cIndex * 3
    const abx = positions[b] - positions[a]
    const aby = positions[b + 1] - positions[a + 1]
    const abz = positions[b + 2] - positions[a + 2]
    const acx = positions[c] - positions[a]
    const acy = positions[c + 1] - positions[a + 1]
    const acz = positions[c + 2] - positions[a + 2]
    const crossX = aby * acz - abz * acy
    const crossY = abz * acx - abx * acz
    const crossZ = abx * acy - aby * acx
    if (crossX * crossX + crossY * crossY + crossZ * crossZ < minimumArea) {
      stats.degenerateTriangles += 1
      if (warnings.length < MAX_DETAILS) {
        warnings.push(`Triangle ${triangle} has near-zero area`)
      }
    }

    addEdgeUse(edgeUses, vertexCount, aIndex, bIndex)
    addEdgeUse(edgeUses, vertexCount, bIndex, cIndex)
    addEdgeUse(edgeUses, vertexCount, cIndex, aIndex)
  }

  for (const edge of edgeUses.values()) {
    if (edge.count === 1) {
      stats.boundaryEdges += 1
      if (
        options.boundaryMode === 'section' &&
        !edgeLiesOnSectionBoundary(
          positions,
          edge.a,
          edge.b,
          options.sectionSize,
          options.boundaryEpsilon,
        )
      ) {
        if (errors.length < MAX_DETAILS) {
          errors.push(`Open edge ${edge.a}:${edge.b} is not on a section boundary`)
        }
      }
    } else if (edge.count > 2) {
      stats.nonManifoldEdges += 1
    }
    if (edge.inconsistent) stats.inconsistentWindingEdges += 1
  }

  if (options.boundaryMode === 'closed' && stats.boundaryEdges > 0) {
    errors.push(`Closed mesh has ${stats.boundaryEdges} boundary edges`)
  }
  if (stats.nonManifoldEdges > 0) {
    errors.push(`Mesh has ${stats.nonManifoldEdges} non-manifold edges`)
  }
  if (options.rejectDegenerateTriangles && stats.degenerateTriangles > 0) {
    errors.push(`Mesh has ${stats.degenerateTriangles} degenerate or sliver triangles`)
  }
  if ((options.checkWinding ?? true) && stats.inconsistentWindingEdges > 0) {
    errors.push(
      `Mesh has ${stats.inconsistentWindingEdges} inconsistently wound shared edges`,
    )
  }

  return { valid: errors.length === 0, errors, warnings, stats }
}

function addEdgeUse(
  edges: Map<number, EdgeUse>,
  vertexCount: number,
  a: number,
  b: number,
): void {
  const minimum = Math.min(a, b)
  const maximum = Math.max(a, b)
  const key = minimum * vertexCount + maximum
  const existing = edges.get(key)
  if (!existing) {
    edges.set(key, { a, b, count: 1, inconsistent: false })
    return
  }
  existing.count += 1
  if (existing.a === a && existing.b === b) existing.inconsistent = true
}

function edgeLiesOnSectionBoundary(
  positions: Float32Array,
  a: number,
  b: number,
  sectionSize = 0,
  epsilon = Math.max(1e-4, sectionSize * 1e-5),
): boolean {
  const first = a * 3
  const second = b * 3
  const samePlane = (axis: 0 | 2, plane: number) =>
    Math.abs(positions[first + axis] - plane) <= epsilon &&
    Math.abs(positions[second + axis] - plane) <= epsilon
  return (
    samePlane(0, 0) ||
    samePlane(0, sectionSize) ||
    samePlane(2, 0) ||
    samePlane(2, sectionSize)
  )
}
