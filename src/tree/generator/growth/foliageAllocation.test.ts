import { describe, expect, it } from 'vitest'
import { generateSemanticTree } from '../semanticGraph'
import {
  DEFAULT_TREE_ENVIRONMENT,
  TREE_SPECIES_PRESETS,
  type FoliageCluster,
  type TreeSpecies,
} from '../types'

function maximumMetreCellOccupancy(clusters: readonly FoliageCluster[]): number {
  const cells = new Map<string, number>()
  for (const cluster of clusters) {
    const key = `${Math.floor(cluster.center.x)},${Math.floor(cluster.center.y)},${Math.floor(cluster.center.z)}`
    cells.set(key, (cells.get(key) ?? 0) + 1)
  }
  return Math.max(0, ...cells.values())
}

describe('colonized-crown foliage allocation', () => {
  it('never recreates a hundred-spray hotspot on sparse or clustered crowns', () => {
    const species: TreeSpecies[] = [
      'windswept-pine',
      'rainbow-eucalyptus',
      'silver-birch',
      'cedar-of-lebanon',
    ]
    for (const id of species) {
      for (const seed of [TREE_SPECIES_PRESETS[id].seed, 73129, 275191]) {
        const graph = generateSemanticTree(
          { ...TREE_SPECIES_PRESETS[id], seed },
          DEFAULT_TREE_ENVIRONMENT,
        )
        expect(maximumMetreCellOccupancy(graph.foliageClusters)).toBeLessThanOrEqual(8)
        const partIds = new Set(graph.parts.map((part) => part.id))
        expect(graph.foliageClusters.every((cluster) => partIds.has(cluster.partId)))
          .toBe(true)
      }
    }
  }, 20_000)
})
