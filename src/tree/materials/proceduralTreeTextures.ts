import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type Texture,
} from 'three/webgpu'
import type { TreeSpecies } from '../generator/types'
import { LEAF_CARD_VARIANTS } from '../generator/foliageCompiler'
import { bakeLeafSpray } from './leafSprayAtlas'
import {
  byte,
  cellularBorder,
  clamp01,
  columnBorder,
  hash2,
  mix,
  smooth01,
  tiledFbm,
  tiledValueNoise,
} from './proceduralNoise'

/**
 * Tiling noise sampled in texture space.
 *
 * Callers give a frequency in whole cycles across the tile; that frequency is
 * also the lattice period, which is what makes the result meet itself at the
 * boundary. Whole numbers are not a nicety here — a fractional frequency has no
 * period at all and puts the seam straight back.
 */
function noise(
  u: number,
  v: number,
  cyclesU: number,
  cyclesV: number,
  seed: number,
): number {
  return tiledValueNoise(u * cyclesU, v * cyclesV, seed, cyclesU, cyclesV)
}

function fbmTiled(
  u: number,
  v: number,
  cyclesU: number,
  cyclesV: number,
  seed: number,
  octaves: number,
): number {
  return tiledFbm(u * cyclesU, v * cyclesV, seed, octaves, cyclesU, cyclesV)
}

export interface LeafCardTextures {
  map: DataTexture
  normalMap: DataTexture
  /** R roughness, G translucency. */
  surfaceMap: DataTexture
}

export interface ProceduralTreeTextures {
  barkMap: DataTexture
  barkNormalMap: DataTexture
  barkRoughnessMap: DataTexture
  /** One entry per leaf-spray variant; cards are batched per variant. */
  leafCards: LeafCardTextures[]
  dispose(): void
}

const BARK_WIDTH = 1024
const BARK_HEIGHT = 2048
const LEAF_CARD_SIZE = 512

/**
 * World size of one bark tile, so texel density is the same on every member.
 *
 * 1024 texels over 1.6 m is 640 px/m, which puts a veteran oak's 7 cm plate at
 * about 45 texels. Denser than that and the whole plate network falls below a
 * few screen pixels on a trunk two metres across — the bark stops being
 * fissured wood and becomes a fine grey fur.
 */
export const BARK_TILE_METRES = 1.6

/**
 * Bakes deterministic PBR textures in memory. Geometry carries only macro
 * deformation; fissures, plates, veins, pores, and micro breakup live here.
 */
export function bakeProceduralTreeTextures(
  species: TreeSpecies,
  seed: number,
): ProceduralTreeTextures {
  const bark = bakeBarkMaps(seed, species)
  const leafCards: LeafCardTextures[] = []
  for (let variant = 0; variant < LEAF_CARD_VARIANTS; variant += 1) {
    const spray = bakeLeafSpray(seed ^ 0x5f3759df, species, variant, LEAF_CARD_SIZE)
    leafCards.push({
      map: makeTexture(
        spray.albedo, LEAF_CARD_SIZE, LEAF_CARD_SIZE,
        `leaf spray ${variant} albedo`, true, false,
      ),
      normalMap: makeTexture(
        spray.normal, LEAF_CARD_SIZE, LEAF_CARD_SIZE,
        `leaf spray ${variant} normal`, false, false,
      ),
      surfaceMap: makeTexture(
        spray.roughness, LEAF_CARD_SIZE, LEAF_CARD_SIZE,
        `leaf spray ${variant} roughness + translucency`, false, false,
      ),
    })
  }
  const textures: ProceduralTreeTextures = {
    barkMap: makeTexture(bark.albedo, BARK_WIDTH, BARK_HEIGHT, 'bark albedo', true, true),
    barkNormalMap: makeTexture(bark.normal, BARK_WIDTH, BARK_HEIGHT, 'bark tangent normal', false, true),
    barkRoughnessMap: makeTexture(bark.roughness, BARK_WIDTH, BARK_HEIGHT, 'bark roughness', false, true),
    leafCards,
    dispose() {
      for (const texture of textureValues(textures)) texture.dispose()
    },
  }
  return textures
}

/**
 * Oak bark: long vertical furrows separating narrow ridged plates.
 *
 * The shape comes from anisotropic ridged noise rather than from a periodic
 * wave or a Voronoi net. A wave gives evenly spaced grooves and a Voronoi net
 * gives closed cells — the crocodile-hide look — and both read as pattern the
 * moment the camera gets within a few metres. Ridged noise sampled with a
 * strong vertical stretch meanders, branches, varies in width and occasionally
 * dies out, which is what real bark does.
 */
/** Exported so the offline dump tool can inspect the bake, not a render of it. */
export function bakeBarkMaps(
  seed: number,
  species: TreeSpecies,
): {
  albedo: Uint8Array
  normal: Uint8Array
  roughness: Uint8Array
  width: number
  height: number
} {
  const pixelCount = BARK_WIDTH * BARK_HEIGHT
  const heights = new Float32Array(pixelCount)
  const albedo = new Uint8Array(pixelCount * 4)
  const normal = new Uint8Array(pixelCount * 4)
  const roughness = new Uint8Array(pixelCount * 4)
  const pine = species === 'windswept-pine'

  for (let y = 0; y < BARK_HEIGHT; y += 1) {
    const v = y / BARK_HEIGHT
    for (let x = 0; x < BARK_WIDTH; x += 1) {
      const u = x / BARK_WIDTH
      const index = y * BARK_WIDTH + x

      // Domain warp first, and hard. It is what turns a regular cell network
      // into a meandering one, and it is the difference between bark and a
      // printed pattern.
      // Warped mostly *along* the columns, so a ridge snakes from side to side
      // over its length instead of running as a ruled line.
      const warpX = (noise(u, v, 2, 3, seed + 11) - 0.5) * 0.2 +
        (noise(u, v, 6, 8, seed + 29) - 0.5) * 0.055
      const warpY = (noise(u, v, 2, 2, seed + 47) - 0.5) * 0.1 +
        (noise(u, v, 6, 6, seed + 59) - 0.5) * 0.026
      const wu = u + warpX
      const wv = v + warpY

      // Oak bark is columnar: long vertical furrows of varying spacing and
      // width, crossed only occasionally. Built as a single two-dimensional
      // cell network it comes out as reptile skin, because such a network's
      // borders are equally strong in both axes and its horizontal ones fall
      // into a visible repeating rhythm. The two axes are therefore built
      // separately, and the vertical one dominates.
      // Coarse. A veteran oak's ridges are ten to twenty centimetres across,
      // and at fifteen columns to the tile they came out fine enough to read as
      // combed grain rather than as plates a hand could grip.
      const columns = pine ? 11 : 9
      const column = columnBorder(wu * columns, seed + 83, columns)
      // Per-column depth and width. Neighbouring ridges on a real trunk are not
      // parted equally: some furrows are deep chasms, some are hairlines, and
      // some pinch out entirely over their length.
      // Sampled per column *and* along it, so a single furrow widens, narrows
      // and pinches out over its length instead of running the whole tile at
      // one width like a scored line.
      const columnDepth = 0.22 +
        hash2(column.cell, 7, seed + 97) * 0.7 +
        // Keyed to the column index so a whole ridge shares a profile, and
        // periodic along v so the profile meets itself at the tile boundary.
        tiledFbm(column.cell * 0.83, v * 4, seed + 113, 3, 16, 4) * 1.05
      const major = smooth01((0.2 * columnDepth - column.border) * 5.5)
      // Each plate crowns away from its own furrows, so the surface between
      // them is a rounded ridge rather than a flat facet. This is what lets a
      // raking sun pick the plates out individually.
      const crown = smooth01(column.border * 4.4)

      // Sparse horizontal breaks. Masked hard, so most of the trunk shows
      // uninterrupted vertical runs and the cross-links read as incidents
      // rather than as a grid.
      // These have to be common enough to actually segment the ridges. Left as
      // rare incidents, every furrow ran the full height of the tile and the
      // trunk read as an extruded, combed column.
      const linkX = pine ? 9 : 8
      const linkY = pine ? 22 : 7
      const linkBorder = cellularBorder(
        wu * linkX + 5.7, wv * linkY - 2.3, seed + 131, linkX, linkY, 0.62,
      )
      const linkMask = smooth01((fbmTiled(u, v, 4, 4, seed + 149, 3) - 0.36) * 4)
      const link = smooth01((0.115 - linkBorder) * 9) * linkMask

      // A finer network inside each plate, for the secondary cracking.
      const minorX = pine ? 26 : 30
      const minorY = pine ? 30 : 13
      const minorBorder = cellularBorder(
        wu * minorX + 3.1, wv * minorY - 1.7, seed + 109, minorX, minorY, 0.46,
      )
      // Masked down to short cracks. Left unmasked this network draws a
      // complete polygon outline on every plate face, which reads as crazed
      // pottery glaze rather than as wood.
      const minorMask = smooth01((fbmTiled(u, v, 7, 6, seed + 167, 3) - 0.48) * 4.4)
      const minorDepth = 0.4 + fbmTiled(u, v, 14, 10, seed + 127, 3) * 0.85
      const minor = smooth01((0.09 * minorDepth - minorBorder) * 12) * minorMask

      const furrow = clamp01(
        major * (pine ? 0.78 : 0.92) + link * 0.72 + minor * 0.24,
      )
      // Plate faces crown slightly and carry their own corky grain, which is
      // what catches a raking sun.
      // Plate-to-plate value variation, keyed to the column so a whole ridge
      // weathers together. Neighbouring plates age at different rates, and a
      // uniform field of them reads as one printed sheet.
      const plateShade = 0.78 +
        hash2(column.cell, 19, seed + 307) * 0.28 +
        fbmTiled(u, v, 18, 6, seed + 311, 2) * 0.2
      const plate = fbmTiled(u, v, 13, pine ? 22 : 8, seed + 173, 4)
      const grain = fbmTiled(u, v, 34, 46, seed + 211, 4)
      const micro = fbmTiled(u, v, 120, 164, seed + 233, 2)
      const height = clamp01(
        0.26 + crown * 0.34 + plate * 0.22 + grain * 0.14 + micro * 0.07 -
          furrow * 0.88,
      )
      heights[index] = height

      // Lenticels: the small raised corky pores that break up a plate face.
      const lenticel = smooth01(
        (noise(u, v, 96, 48, seed + 251) - 0.86) * 12,
      ) * (1 - furrow)
      heights[index] = clamp01(heights[index]! + lenticel * 0.12)

      const moisture = noise(u, v, 4, 4, seed + 151)
      const mossNoise = fbmTiled(u, v, 3, 6, seed + 179, 4)
      const lichenNoise = fbmTiled(u, v, 9, 9, seed + 191, 3)
      // Moss colonises the damp side and the furrow floors; lichen takes the
      // dry exposed ridges. Putting both in the same places is a common tell.
      const moss = pine
        ? smooth01((mossNoise - 0.74) * 4.4) * 0.16
        : smooth01((mossNoise - 0.58) * 3.4) * mix(0.25, 1, furrow) * 0.4
      const lichen = smooth01((lichenNoise - 0.62) * 4.6) *
        (1 - furrow) * (pine ? 0.14 : 0.26)

      // Cavity occlusion. Bark albedo is nearly uniform in reality; almost all
      // of its apparent contrast is dirt and shadow packed into the furrows.
      // The range stays well clear of black — a furrow floor is dim, not unlit,
      // and crushing it is what turned the whole trunk into a silhouette.
      // A shallower curve than a physical AO would give. The furrows are the
      // deepest thing in the map, and squaring them off drops the trunk's
      // darkest values below anything a sunlit surface should reach.
      const cavity = Math.pow(clamp01(height * 1.3), 0.95)
      const light = (0.4 + cavity * 0.72 + (grain - 0.5) * 0.1 +
        (micro - 0.5) * 0.06) * plateShade

      // Grey-brown, not chocolate. Weathered oak bark is a desaturated stone
      // grey with a warm cast; the saturated brown it is usually painted as
      // only exists on bark that is freshly wet.
      const barkRed = (pine ? 0.42 : 0.335) + moisture * (pine ? 0.07 : 0.04)
      const barkGreen = (pine ? 0.27 : 0.312) + moisture * 0.034
      const barkBlue = (pine ? 0.16 : 0.272) + moisture * 0.028
      const lichenValue = 0.56 + lichenNoise * 0.16
      const mossed = (base: number, mossValue: number) =>
        mix(base * light, mossValue * light, moss)
      const offset = index * 4
      albedo[offset] = byte(mix(mossed(barkRed, 0.19), lichenValue * light, lichen))
      albedo[offset + 1] = byte(
        mix(mossed(barkGreen, 0.33), lichenValue * 0.99 * light, lichen),
      )
      albedo[offset + 2] = byte(
        mix(mossed(barkBlue, 0.15), lichenValue * 0.86 * light, lichen),
      )
      albedo[offset + 3] = 255

      // Weathered ridge crowns are polished smoother than the damp, dusty
      // furrow floors; a constant roughness is what makes bark read as plastic.
      const rough = clamp01(
        0.96 - cavity * 0.2 + furrow * 0.06 + grain * 0.05 - lichen * 0.12,
      )
      const roughByte = byte(rough)
      roughness[offset] = roughByte
      roughness[offset + 1] = roughByte
      roughness[offset + 2] = roughByte
      roughness[offset + 3] = 255
    }
  }

  heightToNormal(heights, normal, BARK_WIDTH, BARK_HEIGHT, pine ? 16 : 14, true)
  return { albedo, normal, roughness, width: BARK_WIDTH, height: BARK_HEIGHT }
}

function heightToNormal(
  heights: Float32Array,
  target: Uint8Array,
  width: number,
  height: number,
  strength: number,
  wrapX: boolean,
): void {
  for (let y = 0; y < height; y += 1) {
    const previousY = Math.max(0, y - 1)
    const nextY = Math.min(height - 1, y + 1)
    for (let x = 0; x < width; x += 1) {
      const previousX = wrapX ? (x - 1 + width) % width : Math.max(0, x - 1)
      const nextX = wrapX ? (x + 1) % width : Math.min(width - 1, x + 1)
      const dx = (heights[y * width + nextX]! - heights[y * width + previousX]!) * strength
      const dy = (heights[nextY * width + x]! - heights[previousY * width + x]!) * strength
      const inverseLength = 1 / Math.hypot(dx, dy, 1)
      const offset = (y * width + x) * 4
      target[offset] = byte(-dx * inverseLength * 0.5 + 0.5)
      target[offset + 1] = byte(-dy * inverseLength * 0.5 + 0.5)
      target[offset + 2] = byte(inverseLength * 0.5 + 0.5)
      target[offset + 3] = 255
    }
  }
}

function makeTexture(
  data: Uint8Array,
  width: number,
  height: number,
  name: string,
  srgb: boolean,
  repeat: boolean,
): DataTexture {
  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType)
  texture.name = name
  texture.colorSpace = srgb ? SRGBColorSpace : texture.colorSpace
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8
  if (repeat) {
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
  }
  texture.needsUpdate = true
  return texture
}

function textureValues(textures: ProceduralTreeTextures): Texture[] {
  return [
    textures.barkMap,
    textures.barkNormalMap,
    textures.barkRoughnessMap,
    ...textures.leafCards.flatMap((card) => [card.map, card.normalMap, card.surfaceMap]),
  ]
}
