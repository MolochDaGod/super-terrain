import type { TreeSpecies } from '../../generator/types'
import { packBarkAlbedo, packBarkRoughness } from './albedo'
import { packBarkAmbientOcclusion } from './ambientOcclusion'
import { bakeBarkFields, barkRelief } from './fields'
import { packPalmBarkAlbedo } from './palmAlbedo'
import { packPalmRingAlbedo } from './palmRingAlbedo'
import { barkProfileFor } from './profiles'
import type { BarkMaps, BarkProfile } from './types'

/**
 * A 1.6-metre tile at this width is about 0.8mm per texel, which resolves cork
 * granulation rather than merely implying it — the difference is visible from
 * anywhere closer than arm's length and invisible beyond a couple of metres.
 * The map is twice as tall as it is wide because the world tile is.
 *
 * The cost is real and worth stating: the three maps are 96MB per species at
 * this size against 24MB at 1024, and the bake is four times the work. Halving
 * both numbers here is the whole change needed to go back.
 */
const BARK_WIDTH = 2048
const BARK_HEIGHT = 4096

/**
 * How much ground-level moss a structure family carries by default.
 *
 * Keyed off the structure rather than the species so a new species inherits a
 * sane answer: the plated and fissured hardwood barks of a wet temperate
 * forest hold a colony, smooth and papery barks shed it, and nothing in the
 * palm or desert families ever grows one.
 */
function mossinessForStructure(structure: BarkProfile['structure']): number {
  switch (structure) {
    case 'palm-rings':
    case 'palm-boots':
      return 0
    case 'papery-strips':
      return 0.34
    // A smooth bark sheds flaking colonies but holds an algal and moss film
    // better than a plated one, and beech is the species this exists for.
    case 'mottled-smooth':
      return 0.62
    default:
      return 0.85
  }
}

/**
 * Bakes a deterministic tiling PBR bark set.
 *
 * One structure pass produces the fissures, plates and flaking; the colour and
 * surface passes then read that same structure, so albedo, relief and occlusion
 * describe the same surface instead of three unrelated ones. Albedo stays free
 * of directional lighting; the surface map follows glTF ORM conventions.
 */
export function bakeBarkMaps(
  seed: number,
  species: TreeSpecies,
  /**
   * Overridable so a test can exercise the whole pipeline without paying for
   * two megapixels. Every field derives its vertical frequency from the ratio
   * of these two, so any size with the same aspect produces the same material.
   */
  width = BARK_WIDTH,
  height = BARK_HEIGHT,
): BarkMaps {
  const profile = barkProfileFor(species)
  const pixels = width * height
  const albedo = new Uint8Array(pixels * 4)
  const normal = new Uint8Array(pixels * 4)
  const roughness = new Uint8Array(pixels * 4)

  const fields = bakeBarkFields(seed, profile, width, height)
  if (profile.structure === 'palm-rings') {
    packPalmRingAlbedo(fields, profile.palette, albedo, seed)
  } else if (profile.structure === 'palm-boots') {
    packPalmBarkAlbedo(fields, profile.palette, albedo, seed)
  } else {
    packBarkAlbedo(fields, profile.palette, profile, albedo, seed)
  }
  packBarkRoughness(fields, roughness)
  packBarkAmbientOcclusion(
    fields.relief, fields.furrow, roughness, width, height, fields.lip,
  )
  barkRelief(fields, normal, profile.normalStrength)
  return {
    albedo,
    normal,
    roughness,
    width,
    height,
    // 0.12 was the default here, and at that strength the normal map may as
    // well not have been bound: every hardwood bark in the catalogue rendered
    // as a smooth painted cylinder, with all the fissure and grain relief the
    // bake spends most of its time producing attenuated to nothing. Only the
    // palms ever overrode it, which is why they were the only barks that
    // caught a raking light. The maps themselves were always fine.
    normalScale: profile.runtimeNormalScale ?? 0.7,
    projection: profile.projection ?? 'world-triplanar',
    mossiness: profile.mossiness ?? mossinessForStructure(profile.structure),
  }
}
