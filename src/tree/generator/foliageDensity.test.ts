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
  normalizeTreeParameters,
} from './types'

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

  it('keeps deterministic card counts and bounded LOD scaling at high density', () => {
    const parameters = normalizeTreeParameters({
      ...DEFAULT_TREE_PARAMETERS,
      branchCount: 5,
      rootCount: 5,
      foliageDensity: 2,
    })
    const first = generateSemanticTree(parameters, DEFAULT_TREE_ENVIRONMENT)
    const second = generateSemanticTree(parameters, DEFAULT_TREE_ENVIRONMENT)
    expect(second.foliageClusters).toEqual(first.foliageClusters)
    expect(first.foliageClusters).toHaveLength(foliageStationTarget(2))

    const architecture = speciesArchitecture(parameters)
    const hero = compileFoliage(first, parameters, 0)
    const medium = compileFoliage(first, parameters, 1)
    const far = compileFoliage(first, parameters, 2)
    expect(hero.count).toBe(first.foliageClusters.length * architecture.cardsPerStation)
    expect(hero.count).toBe(15_000)
    expect(medium.count).toBeLessThan(hero.count)
    expect(far.count).toBeLessThanOrEqual(121)
  }, 20_000)
})
