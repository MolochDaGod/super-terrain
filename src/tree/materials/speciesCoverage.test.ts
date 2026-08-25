import { describe, expect, it } from 'vitest'
import { TREE_SPECIES_DEFINITIONS } from '../generator/speciesCatalog'
import { barkProfileFor } from './bark/profiles'
import { leafProfileFor } from './leaf/profiles'
import { bakeBarkMaps } from './bark/bake'
import { bakeLeafSpray } from './leafSprayAtlas'

/**
 * The texture layer routes off the species catalog's profile names. Both
 * lookups fall back to a temperate-oak profile for an unknown name, which keeps
 * a half-added species rendering instead of crashing — but silently, so a new
 * conifer or palm would ship wearing oak bark and oak leaves and nothing would
 * fail. These tests are what make that loud.
 */
describe('species texture coverage', () => {
  const barkNames = new Set(TREE_SPECIES_DEFINITIONS.map((d) => d.barkProfile))
  const foliageNames = new Set(TREE_SPECIES_DEFINITIONS.map((d) => d.foliageProfile))

  it('has a distinct bark profile for every catalog bark name', () => {
    const oak = barkProfileFor('ancient-oak')
    const unmapped = [...barkNames].filter(
      (name) => name !== 'temperate-fissured' &&
        TREE_SPECIES_DEFINITIONS.some(
          (d) => d.barkProfile === name && barkProfileFor(d.id) === oak,
        ),
    )
    expect(unmapped).toEqual([])
  })

  it('has a leaf profile for every catalog foliage name', () => {
    const oak = leafProfileFor('ancient-oak')
    // Palmate and frond foliage deliberately share the broadleaf bake until
    // they have outline generators of their own; list them so the exemption is
    // a decision on the record rather than an accident.
    const knownFallbacks = new Set(['oak-lobed'])
    const unmapped = [...foliageNames].filter(
      (name) => !knownFallbacks.has(name) &&
        TREE_SPECIES_DEFINITIONS.some(
          (d) => d.foliageProfile === name && leafProfileFor(d.id) === oak,
        ),
    )
    expect(unmapped).toEqual([])
  })

  it('bakes every species without producing an empty or broken map', () => {
    for (const definition of TREE_SPECIES_DEFINITIONS) {
      const spray = bakeLeafSpray(4242, definition.id, 0, 64)
      let opaque = 0
      for (let index = 3; index < spray.albedo.length; index += 4) {
        if (spray.albedo[index]! > 128) opaque += 1
      }
      expect(opaque, `${definition.id} leaf spray is empty`).toBeGreaterThan(20)
      for (const value of spray.normal) expect(Number.isFinite(value)).toBe(true)
    }
  }, 20_000)

  it('bakes bark for a representative of each family without NaN', () => {
    for (const species of ['ancient-oak', 'coast-redwood', 'quiver-tree'] as const) {
      const bark = bakeBarkMaps(4242, species, 128, 256)
      for (const channel of [bark.albedo, bark.normal, bark.roughness]) {
        let zeros = 0
        for (let index = 0; index < channel.length; index += 4111) {
          if (channel[index] === 0) zeros += 1
        }
        // A NaN anywhere in the pipeline packs as a zero byte, so a map that is
        // mostly zero is the signature of an arithmetic fault upstream.
        expect(zeros, `${species} produced a mostly-black map`).toBeLessThan(60)
      }
    }
  }, 30_000)
})
