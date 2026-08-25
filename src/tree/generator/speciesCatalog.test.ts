import { describe, expect, it } from 'vitest'
import { TREE_SPECIES_PRESETS } from './types'
import {
  isTreeSpecies,
  TREE_SPECIES_DEFINITIONS,
  treeSpeciesDefinition,
} from './speciesCatalog'

describe('tree species catalog', () => {
  it('keeps catalog entries and usable presets exhaustive', () => {
    const ids = TREE_SPECIES_DEFINITIONS.map(({ id }) => id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.keys(TREE_SPECIES_PRESETS).sort()).toEqual([...ids].sort())
    for (const id of ids) {
      expect(isTreeSpecies(id)).toBe(true)
      expect(treeSpeciesDefinition(id).id).toBe(id)
      expect(TREE_SPECIES_PRESETS[id].species).toBe(id)
    }
    expect(isTreeSpecies('unfinished-tree')).toBe(false)
  })
})
