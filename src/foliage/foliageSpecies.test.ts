import { describe, expect, it } from 'vitest'
import {
  FOLIAGE_MASK_ROWS,
  FOLIAGE_SPECIES,
  FOLIAGE_SPECIES_COUNT,
  FOLIAGE_SPECIES_STRIDE,
  foliageSpeciesIndex,
  packFoliageSpecies,
} from './foliageSpecies'

describe('ground cover palette', () => {
  it('carries every species in the paint mask', () => {
    // The mask stores four species weights per vec4 row, and the paint kernel,
    // the population kernel and the ground material all index it by this. A
    // species past the last row is paintable in the UI and invisible on the
    // ground, which is the kind of failure that looks like a shader bug.
    expect(FOLIAGE_MASK_ROWS * 4).toBeGreaterThanOrEqual(FOLIAGE_SPECIES_COUNT)
    expect(FOLIAGE_MASK_ROWS).toBe(Math.ceil(FOLIAGE_SPECIES_COUNT / 4))
  })

  it('packs one complete table row set per species', () => {
    expect(packFoliageSpecies()).toHaveLength(
      FOLIAGE_SPECIES_COUNT * FOLIAGE_SPECIES_STRIDE,
    )
  })

  it('has unique ids that round-trip through the shader index', () => {
    const ids = FOLIAGE_SPECIES.map((species) => species.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const [index, id] of ids.entries()) {
      expect(foliageSpeciesIndex(id)).toBe(index)
    }
  })

  it('covers every height band a forest floor is built from', () => {
    // Ground cover reads as real when several unrelated heights share the same
    // square metre. A palette clustered into one band composites into a lawn
    // however many species are in it, which is what "no amount of combining
    // them" means in practice.
    const heights = FOLIAGE_SPECIES.map((species) => species.height)
    const inBand = (low: number, high: number) =>
      heights.filter((height) => height >= low && height < high).length
    expect(inBand(0, 0.1), 'ground mat').toBeGreaterThan(0)
    expect(inBand(0.1, 0.35), 'low herbs').toBeGreaterThan(1)
    expect(inBand(0.35, 0.7), 'mid layer').toBeGreaterThan(1)
    expect(inBand(0.7, 3), 'tall layer').toBeGreaterThan(1)
  })

  it('keeps the palette physically plausible', () => {
    for (const species of FOLIAGE_SPECIES) {
      expect(species.height, species.id).toBeGreaterThan(0)
      expect(species.densityScale, species.id).toBeGreaterThan(0)
      expect(species.bladesPerClump, species.id).toBeGreaterThan(0)
      for (const channel of [...species.base, ...species.tip]) {
        // Linear-space albedo. A value above one is an emitter, and ground
        // cover that emits is how a floor ends up brighter than the sky.
        expect(channel, species.id).toBeGreaterThanOrEqual(0)
        expect(channel, species.id).toBeLessThanOrEqual(1)
      }
    }
  })
})
