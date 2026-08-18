import {
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardNodeMaterial,
  RepeatWrapping,
  RGBAFormat,
} from 'three/webgpu'
import {
  float,
  normalWorld,
  positionWorld,
  texture,
  triplanarTexture,
  vertexColor,
} from 'three/tsl'
import {
  DEFAULT_TERRAIN_MATERIAL_SETTINGS,
  type TerrainMaterialSettings,
} from './materialSettings'
import { applyTerrainPaint } from './terrainPaintMaterial'

export interface TerrainMaterialResources {
  material: MeshStandardNodeMaterial
  dispose(): void
}

/**
 * One tiny repeating detail texture, sampled on three world-space planes.
 * World coordinates make the projection continuous across section/LOD swaps;
 * the existing vertex color remains responsible for biome and cave coloring.
 */
export function createTerrainMaterial(
  settings: TerrainMaterialSettings = DEFAULT_TERRAIN_MATERIAL_SETTINGS,
): TerrainMaterialResources {
  const detailTexture = createDetailTexture()
  const detail = triplanarTexture(
    texture(detailTexture),
    null,
    null,
    float(0.075),
    positionWorld,
    normalWorld,
  ).rgb
  const material = new MeshStandardNodeMaterial({
    roughness: 0.94,
    metalness: 0,
    side: DoubleSide,
  })
  const baseColor = vertexColor().mul(detail.mul(0.32).add(0.78))
  const painted = applyTerrainPaint(baseColor, float(0.94), settings)
  material.colorNode = painted.color
  material.roughnessNode = painted.roughness
  return {
    material,
    dispose() {
      material.dispose()
      detailTexture.dispose()
    },
  }
}

function createDetailTexture(size = 64): DataTexture {
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const broad = valueNoise(x * 0.19, y * 0.19, 941)
      const fine = valueNoise(x * 0.61, y * 0.61, 1931)
      const value = Math.round(166 + broad * 64 + fine * 25)
      const offset = (y * size + x) * 4
      pixels[offset] = value
      pixels[offset + 1] = Math.min(255, value + 3)
      pixels[offset + 2] = Math.max(0, value - 5)
      pixels[offset + 3] = 255
    }
  }
  const result = new DataTexture(pixels, size, size, RGBAFormat)
  result.wrapS = RepeatWrapping
  result.wrapT = RepeatWrapping
  result.magFilter = LinearFilter
  result.minFilter = LinearMipmapLinearFilter
  result.generateMipmaps = true
  result.anisotropy = 4
  result.needsUpdate = true
  return result
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = smoothFraction(x - x0)
  const ty = smoothFraction(y - y0)
  const a = hash(x0, y0, seed)
  const b = hash(x0 + 1, y0, seed)
  const c = hash(x0, y0 + 1, seed)
  const d = hash(x0 + 1, y0 + 1, seed)
  return mix(mix(a, b, tx), mix(c, d, tx), ty)
}

function hash(x: number, y: number, seed: number): number {
  let value = Math.imul(x, 374_761_393) + Math.imul(y, 668_265_263)
  value = Math.imul(value ^ (value >>> 13) ^ seed, 1_274_126_177)
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295
}

function smoothFraction(value: number): number {
  return value * value * (3 - 2 * value)
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}
