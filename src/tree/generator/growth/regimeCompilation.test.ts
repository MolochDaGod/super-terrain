import { describe, expect, it } from 'vitest'
import { compileProceduralTree } from '../compileTree'
import {
  DEFAULT_TREE_ENVIRONMENT,
  TREE_SPECIES_PRESETS,
  type TreeSpecies,
} from '../types'

const REGIME_SPECIES: TreeSpecies[] = [
  'kapok-ceiba',
  'baobab',
  'coconut-palm',
  'dragon-blood',
  'norway-spruce',
  'coast-redwood',
  'monkey-puzzle',
  'date-palm',
  'tree-fern',
  'quiver-tree',
  'doum-palm',
  'joshua-tree',
  'screw-pine-pandanus',
  'banyan',
  'mangrove',
  'strangler-fig',
  'umbrella-acacia',
  'rainbow-eucalyptus',
  'gum-eucalyptus',
  'giant-sequoia',
  'norfolk-island-pine',
  'live-oak',
  'european-beech',
  'silver-birch',
  'cedar-of-lebanon',
  'japanese-black-pine',
]

describe('regime asset compilation', () => {
  it('emits finite direct LOD meshes and organ batches for every regime', () => {
    for (const species of REGIME_SPECIES) {
      const asset = compileProceduralTree(
        { ...TREE_SPECIES_PRESETS[species], foliageDensity: 0.35 },
        DEFAULT_TREE_ENVIRONMENT,
      )
      expect(asset.lods[0].wood.indices.length, species).toBeGreaterThan(0)
      expect(asset.lods[0].foliage.count, species).toBeGreaterThan(0)
      for (const lod of asset.lods) {
        expect(Array.from(lod.wood.positions).every(Number.isFinite), species).toBe(true)
        expect(Array.from(lod.foliage.matrices).every(Number.isFinite), species).toBe(true)
        expect(lod.wood.indices.length, species).toBeGreaterThan(0)
      }
      expect(asset.lods[1].wood.indices.length, species)
        .toBeLessThan(asset.lods[0].wood.indices.length)
      expect(asset.lods[2].wood.indices.length, species)
        .toBeLessThan(asset.lods[1].wood.indices.length)
    }
  }, 45_000)
})
