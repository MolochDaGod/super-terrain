import type { SectionKey } from '../core/types'

export type SectionEdge = 'north' | 'east' | 'south' | 'west'

export const SECTION_EDGE_MASK = {
  north: 1,
  east: 2,
  south: 4,
  west: 8,
} as const satisfies Record<SectionEdge, number>

export interface SectionBoundaryData {
  /** Bit field using SECTION_EDGE_MASK for every source vertex. */
  edgeMasks: Uint8Array
  /** Subset of edgeMasks owned by this section's lexicographic boundary rule. */
  ownedEdgeMasks: Uint8Array
  /** Two deterministic u32 words per boundary position, zero for interior vertices. */
  weldKeys: Uint32Array
  boundaryVertexCount: number
}

export interface SectionBoundaryWorldRange {
  minSection: number
  maxSection: number
}

export function boundaryOwner(a: SectionKey, b: SectionKey): SectionKey {
  if (a.x !== b.x) return a.x < b.x ? a : b
  return a.z <= b.z ? a : b
}

export function neighborForEdge(key: SectionKey, edge: SectionEdge): SectionKey {
  switch (edge) {
    case 'north':
      return { x: key.x, z: key.z - 1 }
    case 'east':
      return { x: key.x + 1, z: key.z }
    case 'south':
      return { x: key.x, z: key.z + 1 }
    case 'west':
      return { x: key.x - 1, z: key.z }
  }
}

export function cardinalNeighbors(key: SectionKey): SectionKey[] {
  return [
    neighborForEdge(key, 'north'),
    neighborForEdge(key, 'east'),
    neighborForEdge(key, 'south'),
    neighborForEdge(key, 'west'),
  ]
}

/**
 * Classifies section-local mesh positions against their X/Z ownership planes.
 * Shared vertices receive the same world-space weld key in both neighbours,
 * while only one side is allowed to own topology-changing boundary work.
 */
export function buildSectionBoundaryData(
  positions: Float32Array,
  key: SectionKey,
  sectionSize: number,
  worldRange?: SectionBoundaryWorldRange,
  epsilon = Math.max(1e-4, sectionSize * 1e-5),
): SectionBoundaryData {
  const vertexCount = positions.length / 3
  const edgeMasks = new Uint8Array(vertexCount)
  const ownedEdgeMasks = new Uint8Array(vertexCount)
  const weldKeys = new Uint32Array(vertexCount * 2)
  let boundaryVertexCount = 0

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3
    const x = positions[offset]
    const y = positions[offset + 1]
    const z = positions[offset + 2]
    let mask = 0
    if (Math.abs(z) <= epsilon) mask |= SECTION_EDGE_MASK.north
    if (Math.abs(x - sectionSize) <= epsilon) mask |= SECTION_EDGE_MASK.east
    if (Math.abs(z - sectionSize) <= epsilon) mask |= SECTION_EDGE_MASK.south
    if (Math.abs(x) <= epsilon) mask |= SECTION_EDGE_MASK.west
    if (mask === 0) continue

    edgeMasks[vertex] = mask
    boundaryVertexCount += 1
    let owned = 0
    for (const edge of ['north', 'east', 'south', 'west'] as const) {
      const edgeMask = SECTION_EDGE_MASK[edge]
      if ((mask & edgeMask) === 0) continue
      const neighbor = neighborForEdge(key, edge)
      const outsideWorld = Boolean(
        worldRange &&
        (
          neighbor.x < worldRange.minSection ||
          neighbor.x > worldRange.maxSection ||
          neighbor.z < worldRange.minSection ||
          neighbor.z > worldRange.maxSection
        ),
      )
      const owner = boundaryOwner(key, neighbor)
      if (outsideWorld || (owner.x === key.x && owner.z === key.z)) {
        owned |= edgeMask
      }
    }
    ownedEdgeMasks[vertex] = owned

    const worldX = key.x * sectionSize + x
    const worldZ = key.z * sectionSize + z
    const [low, high] = boundaryWeldKey(worldX, y, worldZ)
    weldKeys[vertex * 2] = low
    weldKeys[vertex * 2 + 1] = high
  }

  return { edgeMasks, ownedEdgeMasks, weldKeys, boundaryVertexCount }
}

export function boundaryWeldKey(x: number, y: number, z: number): [number, number] {
  const values = [x, y, z].map((value) => Math.round(value * 10_000))
  let low = 0x811c9dc5
  let high = 0x9e3779b9
  for (const value of values) {
    const word = value | 0
    low = Math.imul(low ^ word, 0x01000193)
    high = Math.imul(high ^ word, 0x85ebca6b)
    high ^= high >>> 13
  }
  // Zero is reserved for an interior vertex in the packed stream.
  return [(low >>> 0) || 1, (high >>> 0) || 1]
}
