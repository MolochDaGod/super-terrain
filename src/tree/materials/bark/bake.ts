import type { TreeSpecies } from '../../generator/types'
import { packBarkAlbedo, packBarkRoughness } from './albedo'
import { packBarkAmbientOcclusion } from './ambientOcclusion'
import { bakeBarkFields, barkRelief } from './fields'
import { packPalmBarkAlbedo } from './palmAlbedo'
import { packPalmRingAlbedo } from './palmRingAlbedo'
import { barkProfileFor } from './profiles'
import type { BarkMaps } from './types'

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
    normalScale: profile.runtimeNormalScale ?? 0.12,
    projection: profile.projection ?? 'world-triplanar',
  }
}
