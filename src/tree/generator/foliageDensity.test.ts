import { describe, expect, it } from 'vitest'
import { compileFoliage } from './foliageCompiler'
import {
  foliageStationTarget,
  generateSemanticTree,
} from './semanticGraph'
import { speciesArchitecture } from './speciesArchitecture'
import {
  DEFAULT_TREE_ENVIRONMENT,
  DEFAULT_TREE_PARAMETERS,
  MAX_FOLIAGE_DENSITY,
  TREE_SPECIES_PRESETS,
  normalizeTreeParameters,
} from './types'
import type { TreeFoliageData } from './types'

describe('foliage density authoring', () => {
  it('keeps the extended density range through normalization', () => {
    expect(normalizeTreeParameters({ foliageDensity: 1.75 }).foliageDensity).toBe(1.75)
    expect(normalizeTreeParameters({ foliageDensity: 20 }).foliageDensity)
      .toBe(MAX_FOLIAGE_DENSITY)
  })

  it('uses smaller branchlet-scale cards for both foliage species', () => {
    const oak = speciesArchitecture(DEFAULT_TREE_PARAMETERS)
    const pine = speciesArchitecture({
      ...DEFAULT_TREE_PARAMETERS,
      species: 'windswept-pine',
    })
    expect(oak.cardSize).toBeLessThanOrEqual(0.75)
    expect(pine.cardSize).toBeLessThanOrEqual(0.65)
    expect(oak.farClusterSize).toBeGreaterThan(oak.cardSize)
    expect(pine.farClusterSize).toBeGreaterThan(pine.cardSize)
  })

  it('does not clamp the high-density station budget away at one', () => {
    expect(foliageStationTarget(1.5)).toBeGreaterThan(foliageStationTarget(1))
    expect(foliageStationTarget(2)).toBe(5_000)
    expect(foliageStationTarget(200)).toBe(5_000)
  })

  it('keeps deterministic support-bounded counts and bounded LOD scaling at high density', () => {
    const parameters = normalizeTreeParameters({
      ...DEFAULT_TREE_PARAMETERS,
      branchCount: 5,
      rootCount: 5,
      foliageDensity: 2,
    })
    const first = generateSemanticTree(parameters, DEFAULT_TREE_ENVIRONMENT)
    const second = generateSemanticTree(parameters, DEFAULT_TREE_ENVIRONMENT)
    expect(second.foliageClusters).toEqual(first.foliageClusters)
    // The target is an upper budget, not a command to duplicate a sparse
    // crown's few eligible twigs until it reaches 5,000.
    expect(first.foliageClusters.length).toBeLessThan(foliageStationTarget(2))
    const normal = generateSemanticTree(
      { ...parameters, foliageDensity: 1 },
      DEFAULT_TREE_ENVIRONMENT,
    )
    expect(first.foliageClusters.length).toBeGreaterThan(normal.foliageClusters.length)
    const partIds = new Set(first.parts.map((part) => part.id))
    expect(first.foliageClusters.every((cluster) => partIds.has(cluster.partId))).toBe(true)

    const architecture = speciesArchitecture(parameters)
    const hero = compileFoliage(first, parameters, 0)
    const medium = compileFoliage(first, parameters, 1)
    const far = compileFoliage(first, parameters, 2)
    expect(hero.count).toBe(first.foliageClusters.length * architecture.cardsPerStation)
    expect(hero.count).toBeLessThan(15_000)
    expect(medium.count).toBeLessThan(hero.count)
    expect(far.count).toBeLessThan(medium.count)
    expect(far.count).toBeLessThanOrEqual(480)
  }, 20_000)

  /**
   * The LOD contract, and the one assertion in this file that describes what a
   * viewer actually sees. Card count is allowed to fall with distance; leaf
   * area is not, because area is the canopy — it is what closes the sky and
   * what the shadow map turns into floor dapple. A level that keeps a quarter
   * of its area is a level that visibly thins the stand at the boundary and
   * moves every shadow in it, which is what the striding budget used to do:
   * 25–34% retained at level 1 and 5–8% at level 2.
   */
  it('carries the same leaf area through every LOD', () => {
    for (const species of [
      'norway-spruce',
      'european-beech',
      'field-oak',
      // Shrubs carry much smaller cards on a much smaller crown, which is the
      // case most likely to trip the merge cap.
      'hazel-thicket',
      'common-juniper',
    ] as const) {
      const parameters = normalizeTreeParameters({ ...TREE_SPECIES_PRESETS[species] })
      const graph = generateSemanticTree(parameters, DEFAULT_TREE_ENVIRONMENT)
      const near = cardArea(compileFoliage(graph, parameters, 0))
      for (const level of [1, 2] as const) {
        const ratio = cardArea(compileFoliage(graph, parameters, level)) / near
        expect(ratio, `${species} at LOD ${level}`).toBeGreaterThan(0.85)
        expect(ratio, `${species} at LOD ${level}`).toBeLessThan(1.15)
      }
    }
  }, 60_000)

  it('groups stations by neighbourhood, so no limb is combed out', () => {
    const parameters = normalizeTreeParameters({ ...TREE_SPECIES_PRESETS['field-oak'] })
    const graph = generateSemanticTree(parameters, DEFAULT_TREE_ENVIRONMENT)
    // At limb scale the far crown occupies the same cells the near one does.
    // Index striding took every Nth station in *traversal* order, which is
    // branch order, so whichever limbs fell between the teeth of the comb lost
    // their foliage outright; a spatial group is a region of the crown and
    // cannot do that. The remainder is the crown fringe, where a cell holding
    // one station merges into its neighbour.
    const occupied = (level: 0 | 2, cell: number): number => {
      const data = compileFoliage(graph, parameters, level)
      const cells = new Set<string>()
      for (let index = 0; index < data.count; index += 1) {
        const offset = index * 16
        cells.add([12, 13, 14]
          .map((axis) => Math.round(data.matrices[offset + axis]! / cell))
          .join('|'))
      }
      return cells.size
    }
    // Eight tenths, not eighty-two hundredths. The far level's card budget is
    // an absolute ceiling, so the fraction of the near crown's cells it can
    // still reach falls slowly as the crown occupies more space — and an oak
    // now carries lateral limbs down the bole, which is more space. The
    // failure this guards against is a comb dropping whole limbs, and that
    // shows up as a third of the cells going missing, not a fiftieth.
    for (const cell of [2.5, 4]) {
      expect(occupied(2, cell), `${cell}m cells`)
        .toBeGreaterThan(occupied(0, cell) * 0.8)
    }
  }, 30_000)
})

/** Summed card area, the quantity a canopy's density and its shadow both are. */
function cardArea(data: TreeFoliageData): number {
  let total = 0
  for (let index = 0; index < data.count; index += 1) {
    const offset = index * 16
    total += Math.hypot(
      data.matrices[offset]!,
      data.matrices[offset + 1]!,
      data.matrices[offset + 2]!,
    ) * Math.hypot(
      data.matrices[offset + 4]!,
      data.matrices[offset + 5]!,
      data.matrices[offset + 6]!,
    )
  }
  return total
}
