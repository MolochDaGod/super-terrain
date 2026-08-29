import type { FoliagePaintStroke } from './FoliageMaskField'
import { foliageSpeciesIndex, type FoliageSpeciesId } from './foliageSpecies'
import { foliageSurfaceIndex, type FoliageSurfaceId } from './foliageSurfaces'

/**
 * A floor, described rather than drawn.
 *
 * The ground cover used to be two hard-coded lists — one meadow, one forest —
 * and every preset in the tree editor opened on the same one of them. A boreal
 * stand and a beech interior are not the same floor in different light: one is
 * a felt of needles with bilberry and moss on it and almost nothing else, the
 * other is deep leaf litter with fern colonies and bramble. Describing a floor
 * as data lets each preset carry its own without any of them being code.
 *
 * Every field here turns into ordinary brush strokes through the same kernel
 * the toolbar uses, which is what makes a seeded floor no different from a
 * painted one: the competition between species applies, the mixed edges
 * survive, and — the part that was missing — the eraser can take it all back
 * off again, ground layers included.
 */

/** A scattered stand of one plant species. */
export interface FoliageColony {
  species: FoliageSpeciesId
  /** Colonies placed. */
  count: number
  /** Metres from the origin they scatter over. */
  spread: number
  /** Metres across, low and high. */
  radius: readonly [number, number]
  /** Painted weight per colony, low and high. Well under 1 keeps soft edges. */
  flow: readonly [number, number]
  seed: number
}

/** A ground layer: an optional field-wide wash, then patches over it. */
export interface FoliageSurfaceWash {
  surface: FoliageSurfaceId
  /** Coverage laid over the whole field first, 0..1. */
  fill?: number
  count?: number
  spread?: number
  radius?: readonly [number, number]
  flow?: readonly [number, number]
  seed?: number
}

/**
 * Openings: places where the floor has been kept clear.
 *
 * Applied last, and as *erase* strokes, so they thin the plants and the ground
 * layers together and leave the soil showing. A stand whose cover is uniform
 * is the quickest tell that it was scattered rather than grown, and the gaps
 * do more for that than any amount of variation within the cover does — they
 * are what a root plate, a drip line, a game trail or a fallen log leaves.
 */
export interface FoliageBreaks {
  count: number
  spread: number
  radius: readonly [number, number]
  /** How completely each opening clears, 0..1. */
  strength: readonly [number, number]
  /** Fraction of an opening's strength repainted as exposed mineral soil. */
  bareEarth: number
  seed: number
}

export interface FoliageFloorRecipe {
  /** Stable identity. Changing it is what makes the layer reseed. */
  id: string
  label: string
  /** Linear multiplier on the soil albedo. See `FoliageGroundTextures`. */
  soilTint: readonly [number, number, number]
  surfaces: readonly FoliageSurfaceWash[]
  colonies: readonly FoliageColony[]
  breaks?: FoliageBreaks
}

function randomFor(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The recipe as the list of strokes that build it.
 *
 * Order matters and is the whole reason this is a function rather than a loop
 * at the call site. The ground layers go down first and their field-wide
 * washes go down before their patches, because a wash at full flow pushes the
 * other layers back — laying the duff after the moss patches would wipe the
 * moss. Plants follow the ground they grow on, and the openings come last so
 * they cut through everything.
 */
export function floorStrokes(recipe: FoliageFloorRecipe): FoliagePaintStroke[] {
  const strokes: FoliagePaintStroke[] = []

  const dab = (
    x: number,
    z: number,
    radius: number,
    flow: number,
    index: number,
    layer: 'plants' | 'surface',
    mode: 'paint' | 'erase' = 'paint',
  ): void => {
    strokes.push({
      fromX: x,
      fromZ: z,
      toX: x,
      toZ: z,
      radius,
      flow,
      // A solid core with a soft rim, rather than a peak at the very centre.
      //
      // At 0.05 the falloff started five per cent of the way out, so a dab
      // delivered less than half its flow over most of its own footprint and a
      // colony was a faint smudge with a dot in the middle. Colonies have
      // interiors: a fern stand is continuous until its edge, and the edge is
      // where it mixes with what is around it.
      hardness: 0.42,
      species: index,
      layer,
      mode,
    })
  }

  for (const wash of recipe.surfaces) {
    if (!wash.fill) continue
    strokes.push({
      fromX: 0,
      fromZ: 0,
      toX: 0,
      toZ: 0,
      // Half the field radius reaches every corner from the middle.
      radius: 600,
      flow: wash.fill,
      hardness: 0.98,
      species: foliageSurfaceIndex(wash.surface),
      layer: 'surface',
      mode: 'paint',
    })
  }

  for (const wash of recipe.surfaces) {
    const count = wash.count ?? 0
    if (count === 0) continue
    const random = randomFor(wash.seed ?? 0x51ed)
    const index = foliageSurfaceIndex(wash.surface)
    const radius = wash.radius ?? [14, 34]
    const flow = wash.flow ?? [0.3, 0.7]
    const spread = wash.spread ?? 120
    for (let i = 0; i < count; i += 1) {
      const angle = random() * Math.PI * 2
      const distance = Math.sqrt(random()) * spread
      dab(
        Math.cos(angle) * distance,
        Math.sin(angle) * distance,
        radius[0] + random() * (radius[1] - radius[0]),
        flow[0] + random() * (flow[1] - flow[0]),
        index,
        'surface',
      )
    }
  }

  for (const colony of recipe.colonies) {
    const random = randomFor(colony.seed)
    const index = foliageSpeciesIndex(colony.species)
    for (let i = 0; i < colony.count; i += 1) {
      const angle = random() * Math.PI * 2
      // Square-rooted so colonies spread evenly over the disc rather than
      // piling around the origin.
      const distance = Math.sqrt(random()) * colony.spread
      dab(
        Math.cos(angle) * distance,
        Math.sin(angle) * distance,
        colony.radius[0] + random() * (colony.radius[1] - colony.radius[0]),
        colony.flow[0] + random() * (colony.flow[1] - colony.flow[0]),
        index,
        'plants',
      )
    }
  }

  const breaks = recipe.breaks
  if (breaks) {
    const random = randomFor(breaks.seed)
    const bare = foliageSurfaceIndex('bare-earth')
    for (let i = 0; i < breaks.count; i += 1) {
      const angle = random() * Math.PI * 2
      const distance = Math.sqrt(random()) * breaks.spread
      const x = Math.cos(angle) * distance
      const z = Math.sin(angle) * distance
      const radius = breaks.radius[0] + random() * (breaks.radius[1] - breaks.radius[0])
      const strength = breaks.strength[0]
        + random() * (breaks.strength[1] - breaks.strength[0])
      dab(x, z, radius, strength, 0, 'plants', 'erase')
      if (breaks.bareEarth > 0) {
        // Smaller than the opening it sits in: the soil shows in the middle
        // of a scuff, not right out to where the cover thins.
        dab(x, z, radius * 0.62, strength * breaks.bareEarth, bare, 'surface')
      }
    }
  }

  return strokes
}

/**
 * Open pasture, for the workspaces that are not a forest interior.
 *
 * Filled rather than scattered, because a meadow genuinely is continuous — it
 * is the one floor where a wash is the right model.
 */
export const MEADOW_FLOOR: FoliageFloorRecipe = {
  id: 'meadow',
  label: 'Meadow',
  soilTint: [1, 1, 1],
  surfaces: [
    { surface: 'bare-earth', fill: 0.12 },
    { surface: 'leaf-litter', count: 8, spread: 130, radius: [8, 20], flow: [0.2, 0.4], seed: 0x2211 },
  ],
  colonies: [
    { species: 'meadow-fescue', count: 1, spread: 0, radius: [600, 600], flow: [1, 1], seed: 1 },
    { species: 'tussock', count: 14, spread: 130, radius: [24, 52], flow: [0.42, 0.6], seed: 0x11a3 },
    { species: 'dry-steppe', count: 12, spread: 140, radius: [30, 66], flow: [0.4, 0.62], seed: 0x2b57 },
    { species: 'wildflower', count: 16, spread: 130, radius: [16, 40], flow: [0.35, 0.58], seed: 0x3c19 },
    { species: 'clover-mat', count: 18, spread: 128, radius: [12, 34], flow: [0.32, 0.55], seed: 0x4d21 },
    { species: 'broadleaf-weed', count: 14, spread: 132, radius: [10, 32], flow: [0.22, 0.42], seed: 0x5e73 },
    { species: 'sedge-reed', count: 7, spread: 120, radius: [12, 30], flow: [0.4, 0.6], seed: 0x6f31 },
  ],
  breaks: {
    count: 16,
    spread: 130,
    radius: [3, 9],
    strength: [0.5, 0.9],
    bareEarth: 0.8,
    seed: 0x7a09,
  },
}
