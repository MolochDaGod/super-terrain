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
import { LEAF_CARD_VARIANTS } from '../generator/foliageCompiler'
import type { TreeSpecies } from '../generator/types'
import { bakeBarkMaps } from './bark/bake'
import { bakeLeafSpray, type LeafSprayMaps } from './leafSprayAtlas'
import { buildCutoutMipmaps, type MipContent } from './leaf/mipmaps'

// Retain the public diagnostic import used by the offline atlas dump.
export { bakeBarkMaps } from './bark/bake'

export interface LeafCardTextures {
  map: DataTexture
  normalMap: DataTexture
  /** R roughness, G translucency. */
  surfaceMap: DataTexture
}

export interface ProceduralTreeTextures {
  barkMap: DataTexture
  barkNormalMap: DataTexture
  barkNormalScale: number
  barkProjection: 'world-triplanar' | 'axial-uv'
  /** Packed ORM-compatible surface map: R ambient occlusion, G/B roughness. */
  barkRoughnessMap: DataTexture
  /** One entry per leaf-spray variant; cards are batched per variant. */
  leafCards: LeafCardTextures[]
  dispose(): void
}

/** Renderer-independent bytes produced in the texture worker. */
export interface ProceduralTreeTextureData {
  bark: ReturnType<typeof bakeBarkMaps>
  leafCards: LeafSprayMaps[]
}

const LEAF_CARD_SIZE = 512

/**
 * Alpha-test threshold the foliage material uses. The mip builder needs it to
 * know which texels the shader will keep, and the two must not drift apart.
 */
export const LEAF_ALPHA_TEST = 0.3

/** World size of one bark tile, shared with the wood UV compiler. */
export const BARK_TILE_METRES = 1.6

/** Bakes deterministic PBR textures and wraps them as Three GPU resources. */
export function bakeProceduralTreeTextures(
  species: TreeSpecies,
  seed: number,
): ProceduralTreeTextures {
  return createProceduralTreeTextures(bakeProceduralTreeTextureData(species, seed))
}

/** CPU-only half of the bake. Safe to call inside a dedicated worker. */
export function bakeProceduralTreeTextureData(
  species: TreeSpecies,
  seed: number,
): ProceduralTreeTextureData {
  const bark = bakeBarkMaps(seed, species)
  const leafCards: LeafSprayMaps[] = []
  for (let variant = 0; variant < LEAF_CARD_VARIANTS; variant += 1) {
    leafCards.push(
      bakeLeafSpray(seed ^ 0x5f3759df, species, variant, LEAF_CARD_SIZE),
    )
  }
  return { bark, leafCards }
}

/** Main-thread half of the bake: wraps transferred bytes as GPU textures. */
export function createProceduralTreeTextures(
  data: ProceduralTreeTextureData,
): ProceduralTreeTextures {
  const leafCards: LeafCardTextures[] = []
  for (const [variant, spray] of data.leafCards.entries()) {
    leafCards.push({
      map: makeCutoutTexture(
        spray.albedo, spray.size,
        `leaf spray ${variant} albedo`, true, 'srgb-cutout',
      ),
      normalMap: makeCutoutTexture(
        spray.normal, spray.size,
        `leaf spray ${variant} normal`, false, 'normal-cutout',
      ),
      surfaceMap: makeCutoutTexture(
        spray.roughness, spray.size,
        `leaf spray ${variant} roughness + translucency + occlusion`,
        false, 'linear-cutout',
      ),
    })
  }
  const textures: ProceduralTreeTextures = {
    barkMap: makeTexture(
      data.bark.albedo, data.bark.width, data.bark.height,
      'bark albedo', true, true,
    ),
    barkNormalMap: makeTexture(
      data.bark.normal, data.bark.width, data.bark.height,
      'bark tangent normal', false, true,
    ),
    barkNormalScale: data.bark.normalScale,
    barkProjection: data.bark.projection,
    barkRoughnessMap: makeTexture(
      data.bark.roughness, data.bark.width, data.bark.height,
      'bark ambient occlusion + roughness', false, true,
    ),
    leafCards,
    dispose() {
      for (const texture of textureValues(textures)) texture.dispose()
    },
  }
  return textures
}

/**
 * A leaf atlas with a hand-built mip chain.
 *
 * Done here rather than in the worker so the transferred bake and its cache
 * stay the size they are; the chain costs a few tens of milliseconds once per
 * tree build, against a geometry build already measured in seconds.
 */
function makeCutoutTexture(
  data: Uint8Array,
  size: number,
  name: string,
  srgb: boolean,
  content: MipContent,
): DataTexture {
  const levels = buildCutoutMipmaps(data, size, content, LEAF_ALPHA_TEST)
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType)
  texture.name = name
  texture.colorSpace = srgb ? SRGBColorSpace : texture.colorSpace
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.mipmaps = levels
  texture.generateMipmaps = false
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
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
