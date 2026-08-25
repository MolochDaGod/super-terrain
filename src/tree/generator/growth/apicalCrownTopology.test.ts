import { describe, expect, it } from 'vitest'
import { compileFoliage } from '../foliageCompiler'
import { compileFruit } from '../fruitCompiler'
import { generateSemanticTree } from '../semanticGraph'
import {
  DEFAULT_TREE_ENVIRONMENT,
  TREE_SPECIES_PRESETS,
  type TreeVec3,
} from '../types'

function magnitude(x: number, y: number, z: number): number {
  return Math.hypot(x, y, z)
}

function normalise(x: number, y: number, z: number): TreeVec3 {
  const inverse = 1 / Math.max(1e-9, magnitude(x, y, z))
  return { x: x * inverse, y: y * inverse, z: z * inverse }
}

function dot(a: TreeVec3, b: TreeVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

describe('apical frond crown topology', () => {
  it('compiles broad, non-degenerate date fronds from their exact petiole tips', () => {
    const parameters = TREE_SPECIES_PRESETS['date-palm']
    const graph = generateSemanticTree(parameters, DEFAULT_TREE_ENVIRONMENT)
    const foliage = compileFoliage(graph, parameters, 0)

    expect(foliage.cardGeometry).toBe('frond')
    expect(foliage.count).toBe(graph.foliageClusters.length)
    for (let index = 0; index < foliage.count; index += 1) {
      const offset = index * 16
      const x = normalise(
        foliage.matrices[offset]!,
        foliage.matrices[offset + 1]!,
        foliage.matrices[offset + 2]!,
      )
      const y = normalise(
        foliage.matrices[offset + 4]!,
        foliage.matrices[offset + 5]!,
        foliage.matrices[offset + 6]!,
      )
      const z = normalise(
        foliage.matrices[offset + 8]!,
        foliage.matrices[offset + 9]!,
        foliage.matrices[offset + 10]!,
      )
      const width = magnitude(
        foliage.matrices[offset]!,
        foliage.matrices[offset + 1]!,
        foliage.matrices[offset + 2]!,
      )
      const frondLength = magnitude(
        foliage.matrices[offset + 4]!,
        foliage.matrices[offset + 5]!,
        foliage.matrices[offset + 6]!,
      )
      expect(Math.abs(dot(x, y))).toBeLessThan(1e-5)
      expect(Math.abs(dot(x, z))).toBeLessThan(1e-5)
      expect(Math.abs(dot(y, z))).toBeLessThan(1e-5)
      expect(width / frondLength).toBeGreaterThan(0.14)

      const cluster = graph.foliageClusters[index]!
      expect(foliage.matrices[offset + 12]).toBeCloseTo(cluster.center.x, 5)
      expect(foliage.matrices[offset + 13]).toBeCloseTo(cluster.center.y, 5)
      expect(foliage.matrices[offset + 14]).toBeCloseTo(cluster.center.z, 5)
    }
  })

  it('carries each frond on a swept petiole and separates crown age cohorts', () => {
    const graph = generateSemanticTree(
      TREE_SPECIES_PRESETS['date-palm'],
      DEFAULT_TREE_ENVIRONMENT,
    )
    const byId = new Map(graph.parts.map((part) => [part.id, part]))
    const lifts = graph.foliageClusters.map((cluster) => cluster.axis.y)

    // The protected inner rank remains visibly upright without reverting to
    // the old near-vertical, naked spear that pierced the crown silhouette.
    expect(Math.max(...lifts)).toBeGreaterThan(0.52)
    // The oldest rank descends, but never becomes the near-vertical synthetic
    // grass skirt that the original radial-card proxy produced.
    expect(Math.min(...lifts)).toBeLessThan(0.26)
    expect(Math.min(...lifts)).toBeGreaterThan(-0.42)
    for (const cluster of graph.foliageClusters) {
      const petiole = byId.get(cluster.partId)!
      expect(petiole.id).toMatch(/^regime-apical-petiole-/)
      const tip = petiole.spine.at(-1)!.position
      expect(magnitude(
        cluster.center.x - tip.x,
        cluster.center.y - tip.y,
        cluster.center.z - tip.z,
      )).toBeLessThan(0.05)
    }
  })

  it('gives a palm column dense geometric leaf-scar relief instead of a stick', () => {
    const graph = generateSemanticTree(
      TREE_SPECIES_PRESETS['date-palm'],
      DEFAULT_TREE_ENVIRONMENT,
    )
    const trunk = graph.parts.find((part) => part.id === 'trunk')!
    const middle = trunk.spine.slice(
      Math.floor(trunk.spine.length * 0.18),
      Math.floor(trunk.spine.length * 0.82),
    )
    let peaks = 0
    for (let index = 1; index < middle.length - 1; index += 1) {
      if (
        middle[index]!.radius > middle[index - 1]!.radius &&
        middle[index]!.radius > middle[index + 1]!.radius
      ) peaks += 1
    }
    expect(trunk.spine.length).toBeGreaterThan(180)
    expect(peaks).toBeGreaterThan(25)
  })

  it('uses a fibrous buried base instead of broad exposed woody roots', () => {
    const parameters = TREE_SPECIES_PRESETS['date-palm']
    const graph = generateSemanticTree(
      parameters,
      DEFAULT_TREE_ENVIRONMENT,
    )
    const roots = graph.parts.filter((part) => part.id.startsWith('fibrous-root-'))
    const trunk = graph.parts.find((part) => part.id === 'trunk')!
    expect(trunk.spine.every((sample) => (sample.crossSection.fins?.length ?? 0) === 0))
    expect(roots.length).toBeGreaterThanOrEqual(96)
    expect(roots.length).toBeLessThanOrEqual(128)
    for (const root of roots) {
      const maximumRadius = Math.max(...root.spine.map((sample) => sample.radius))
      const tip = root.spine.at(-1)!.position
      expect(maximumRadius).toBeLessThan(parameters.trunkRadius * 0.15)
      expect(Math.hypot(tip.x, tip.z)).toBeLessThan(parameters.trunkRadius * 3)
      expect(tip.y).toBeLessThan(DEFAULT_TREE_ENVIRONMENT.groundHeight)
    }
    const stalks = graph.parts.filter((part) => /^regime-apical-fruit-stalk-\d+$/.test(part.id))
    expect(stalks).toHaveLength(5)
    expect(graph.parts.filter((part) => part.id.includes('-rachilla-')).length)
      .toBeGreaterThanOrEqual(21)
    expect(graph.fruitClusters).toHaveLength(5)
    expect(graph.fruitClusters.every((cluster) => cluster.count >= 108)).toBe(true)
  })

  it('compiles date bunches as finite fleshy organ instances with an LOD policy', () => {
    const graph = generateSemanticTree(
      TREE_SPECIES_PRESETS['date-palm'],
      DEFAULT_TREE_ENVIRONMENT,
    )
    const hero = compileFruit(graph, 0)
    const medium = compileFruit(graph, 1)
    const far = compileFruit(graph, 2)
    expect(hero.count).toBeGreaterThan(320)
    expect(medium.count).toBeGreaterThan(160)
    expect(medium.count).toBeLessThan(hero.count)
    expect(far.count).toBe(0)
    for (const values of [hero.matrices, hero.colors, medium.matrices, medium.colors]) {
      for (const value of values) expect(Number.isFinite(value)).toBe(true)
    }
  })
})
