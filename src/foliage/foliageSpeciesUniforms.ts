import { uniformArray } from 'three/tsl'
import {
  FOLIAGE_SPECIES,
  FOLIAGE_SPECIES_STRIDE,
  packFoliageSpecies,
} from './foliageSpecies'

const table = /*@__PURE__*/ uniformArray(packFoliageSpecies(), 'vec4')

/**
 * The species table, shared by every shader that needs it.
 *
 * One module-level uniform array rather than one per material: the population
 * kernel, the blade material and the ground canopy all have to agree about how
 * tall a sedge is and what colour a dry tussock tip goes, and three programs
 * each holding their own copy of that is how they stop agreeing.
 */
export function foliageSpeciesRow(species: any, row: number): any {
  return table.element(species.mul(FOLIAGE_SPECIES_STRIDE).add(row))
}

export const foliageSpeciesTable = table

/**
 * Per-species clump abundance, as a compile-time constant.
 *
 * These weight the painted mask before a species is drawn from it, so a brush
 * at full strength puts down the right *number* of ferns and the right number
 * of fescue tufts rather than the same count of both. Baking them means the
 * population kernel needs no uniform lookup to decide whether to place
 * anything at all — it is the earliest and hottest branch in the kernel.
 */
export const FOLIAGE_DENSITY_SCALES = FOLIAGE_SPECIES.map(
  (species) => species.densityScale,
)
