import { describe, expect, it } from 'vitest'
import {
  SHOWCASE_RECIPE,
  defaultRecipeFor,
  normalizeWorldRecipe,
  terrainConfigFor,
} from './worldRecipe'

describe('worldRecipe', () => {
  it('keeps the showcase authored, whatever seed is offered', () => {
    // The demo composition depends on its seed: the massif, the caves and the
    // outcrop sites are all placed relative to what that seed produced.
    expect(defaultRecipeFor('showcase', 999).seed).toBe(SHOWCASE_RECIPE.seed)
    expect(normalizeWorldRecipe({ preset: 'showcase', seed: 999 })).toEqual(
      SHOWCASE_RECIPE,
    )
  })

  it('builds a natural landform for a random range and a flat one for flat ground', () => {
    expect(terrainConfigFor(defaultRecipeFor('wild', 4)).worldProfile).toBe('natural')
    expect(terrainConfigFor(defaultRecipeFor('flat', 4)).worldProfile).toBe('flat')
  })

  it('drops the demo LOD focus for generated worlds', () => {
    expect(terrainConfigFor(SHOWCASE_RECIPE)).not.toHaveProperty('lodDetailFocus')
    expect(terrainConfigFor(defaultRecipeFor('wild', 7)).lodDetailFocus).toBeUndefined()
  })

  it('only authors showcase content for the showcase', () => {
    expect(terrainConfigFor(SHOWCASE_RECIPE).worldContent?.showcase).toBe(true)
    expect(terrainConfigFor(defaultRecipeFor('wild', 7)).worldContent?.showcase).toBe(false)
    expect(terrainConfigFor(defaultRecipeFor('flat', 7)).worldContent).toMatchObject({
      showcase: false,
      outcrops: false,
      water: false,
    })
  })

  it('repairs a malformed stored recipe instead of failing to load a world', () => {
    const repaired = normalizeWorldRecipe({ preset: 'wild', seed: -3, rocks: 900 })
    expect(repaired.seed).toBeGreaterThan(0)
    expect(repaired.rocks).toBeLessThanOrEqual(32)
  })
})
