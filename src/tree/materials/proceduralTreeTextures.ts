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
import { treeSpeciesDefinition } from '../generator/speciesCatalog'
import type { TreeSpecies } from '../generator/types'
import { bakeBarkMaps } from './bark/bake'
import { bakeLeafSpray, type LeafSprayMaps } from './leafSprayAtlas'
import { buildCutoutMipmaps, type MipContent, type MipLevel } from './leaf/mipmaps'

// Retain the public diagnostic import used by the offline atlas dump.
export { bakeBarkMaps } from './bark/bake'

export interface LeafCardTextures {
  map: DataTexture
  normalMap: DataTexture
  /** R roughness, G translucency. */
  surfaceMap: DataTexture
}

export interface LeafAtlasTextures extends LeafCardTextures {
  variants: number
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
  /** Runtime atlas containing the same variants and authored mip levels. */
  leafAtlas?: LeafAtlasTextures
  dispose(): void
}

/** Renderer-independent bytes produced in the texture worker. */
export interface ProceduralTreeTextureData {
  bark: ReturnType<typeof bakeBarkMaps>
  leafCards: LeafSprayTextureData[]
}

export interface LeafSprayTextureData extends LeafSprayMaps {
  mipmaps: {
    albedo: MipLevel[]
    normal: MipLevel[]
    roughness: MipLevel[]
  }
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
  _seed: number,
): ProceduralTreeTextures {
  return createProceduralTreeTextures(
    bakeProceduralTreeTextureData(species, treeMaterialSeed(species)),
  )
}

/**
 * Material identity is independent of an individual tree's growth seed.
 * Geometry, placement and per-card tint still vary per tree; the expensive
 * authored bark/leaf surface is shared by species with the same profiles.
 */
export function treeMaterialKey(species: TreeSpecies): string {
  const definition = treeSpeciesDefinition(species)
  return `${definition.barkProfile}:${definition.foliageProfile}`
}

/** Stable procedural seed for a material profile pair. */
export function treeMaterialSeed(species: TreeSpecies): number {
  const key = treeMaterialKey(species)
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 1) + 1
}

/** CPU-only half of the bake. Safe to call inside a dedicated worker. */
export function bakeProceduralTreeTextureData(
  species: TreeSpecies,
  seed: number,
): ProceduralTreeTextureData {
  const bark = bakeBarkMaps(seed, species)
  const leafCards: LeafSprayTextureData[] = []
  for (let variant = 0; variant < LEAF_CARD_VARIANTS; variant += 1) {
    const spray = bakeLeafSpray(
      seed ^ 0x5f3759df, species, variant, LEAF_CARD_SIZE,
    )
    leafCards.push({
      ...spray,
      mipmaps: {
        albedo: buildCutoutMipmaps(
          spray.albedo, spray.size, 'srgb-cutout', LEAF_ALPHA_TEST,
        ),
        normal: buildCutoutMipmaps(
          spray.normal, spray.size, 'normal-cutout', LEAF_ALPHA_TEST,
        ),
        roughness: buildCutoutMipmaps(
          spray.roughness, spray.size, 'linear-cutout', LEAF_ALPHA_TEST,
        ),
      },
    })
  }
  return { bark, leafCards }
}

/** Main-thread half of the bake: wraps transferred bytes as GPU textures. */
export function createProceduralTreeTextures(
  data: ProceduralTreeTextureData,
  atlasOnly = false,
): ProceduralTreeTextures {
  const leafCards: LeafCardTextures[] = []
  if (!atlasOnly) {
    for (const [variant, spray] of data.leafCards.entries()) {
      leafCards.push({
        map: makeCutoutTexture(
          spray.albedo, spray.size,
          `leaf spray ${variant} albedo`, true, 'srgb-cutout', spray.mipmaps.albedo,
        ),
        normalMap: makeCutoutTexture(
          spray.normal, spray.size,
          `leaf spray ${variant} normal`, false, 'normal-cutout', spray.mipmaps.normal,
        ),
        surfaceMap: makeCutoutTexture(
          spray.roughness, spray.size,
          `leaf spray ${variant} roughness + translucency + occlusion`,
          false, 'linear-cutout', spray.mipmaps.roughness,
        ),
      })
    }
  }
  const leafAtlas = atlasOnly ? makeLeafAtlas(data.leafCards) : undefined
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
    leafAtlas,
    dispose() {
      for (const texture of textureValues(textures)) texture.dispose()
    },
  }
  return textures
}

function makeLeafAtlas(cards: readonly LeafSprayTextureData[]): LeafAtlasTextures {
  const variants = cards.length
  return {
    variants,
    map: makeAtlasTexture(cards.map((card) => card.mipmaps.albedo), 'leaf spray atlas albedo', true),
    normalMap: makeAtlasTexture(
      cards.map((card) => card.mipmaps.normal), 'leaf spray atlas normal', false,
    ),
    surfaceMap: makeAtlasTexture(
      cards.map((card) => card.mipmaps.roughness), 'leaf spray atlas surface', false,
    ),
  }
}

/** Packs equal square mip chains side-by-side without filtering across tiles. */
function makeAtlasTexture(
  chains: readonly MipLevel[][],
  name: string,
  srgb: boolean,
): DataTexture {
  const levels = chains[0]!.map((first, level) => {
    const width = first.width * chains.length
    const data = new Uint8Array(width * first.height * 4)
    for (let variant = 0; variant < chains.length; variant += 1) {
      const source = chains[variant]![level]!
      for (let y = 0; y < source.height; y += 1) {
        const sourceOffset = y * source.width * 4
        const targetOffset = (y * width + variant * source.width) * 4
        data.set(
          source.data.subarray(sourceOffset, sourceOffset + source.width * 4),
          targetOffset,
        )
      }
    }
    return { data, width, height: first.height }
  })
  const base = levels[0]!
  const texture = new DataTexture(
    base.data, base.width, base.height, RGBAFormat, UnsignedByteType,
  )
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
  bakedLevels?: MipLevel[],
): DataTexture {
  const levels = bakedLevels ?? buildCutoutMipmaps(data, size, content, LEAF_ALPHA_TEST)
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
    ...(textures.leafAtlas
      ? [textures.leafAtlas.map, textures.leafAtlas.normalMap, textures.leafAtlas.surfaceMap]
      : []),
    ...textures.leafCards.flatMap((card) => [card.map, card.normalMap, card.surfaceMap]),
  ]
}
