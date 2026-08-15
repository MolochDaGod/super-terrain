import type { SectionKey } from '../core/types'

export type SectionEdge = 'north' | 'east' | 'south' | 'west'

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
