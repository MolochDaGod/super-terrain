import { SNOW_LINE, SNOW_LINE_BAND } from '../compiler/climate'
import { clamp, lerp, smoothstep } from '../core/bounds'
import { evaluateHeight } from '../compiler/TerrainField'

export interface FarFieldMeshData {
  positions: Float32Array
  normals: Float32Array
  /** Preview-mode colours, matched to the compiled section vertex palette. */
  colors: Float32Array
  /** Cheap distant approximation of the full procedural material's albedo. */
  fullColors: Float32Array
  indices: Uint32Array
}

/**
 * The proxy must follow the base terrain closely enough to preserve the
 * distant silhouette. At the previous 96 x 96 resolution each edge covered
 * roughly 171 m of the default world, turning narrow valleys and ridges into
 * long flat chords. Its material uses normal perspective depth for truthful
 * proxy self-occlusion; that depth is cleared after the proxy pass so resident
 * terrain always wins where the two representations overlap.
 */
const FAR_FIELD_TARGET_EDGE_LENGTH = 64
// The showcase now uses a 4 km logical world. At that extent the old minimum
// produced ~43 m triangles, visibly clipping the silhouette of the mountain
// immediately behind the hero in close review shots. 128 segments gives 32 m
// edges while leaving the 16 km/max-resolution path unchanged.
const FAR_FIELD_MIN_SEGMENTS = 128
const FAR_FIELD_MAX_SEGMENTS = 512

export function generateFarFieldMesh(
  worldSize: number,
  seed: number,
): FarFieldMeshData {
  const segments = clamp(
    Math.ceil(worldSize / FAR_FIELD_TARGET_EDGE_LENGTH),
    FAR_FIELD_MIN_SEGMENTS,
    FAR_FIELD_MAX_SEGMENTS,
  )
  const width = segments + 1
  const vertexCount = width * width
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const colors = new Float32Array(vertexCount * 3)
  const fullColors = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(segments * segments * 6)
  const half = worldSize * 0.5

  for (let z = 0; z < width; z += 1) {
    const worldZ = -half + (z / segments) * worldSize
    for (let x = 0; x < width; x += 1) {
      const worldX = -half + (x / segments) * worldSize
      const vertex = z * width + x
      const offset = vertex * 3
      const height = evaluateHeight(worldX, worldZ, seed, [])
      positions[offset] = worldX
      positions[offset + 1] = height
      positions[offset + 2] = worldZ
    }
  }

  calculateGridNormals(positions, normals, width)
  calculateFarFieldColors(positions, normals, colors, fullColors, width, seed)
  let cursor = 0
  for (let z = 0; z < segments; z += 1) {
    for (let x = 0; x < segments; x += 1) {
      const a = z * width + x
      const b = a + 1
      const c = a + width
      const d = c + 1
      indices[cursor++] = a
      indices[cursor++] = c
      indices[cursor++] = b
      indices[cursor++] = b
      indices[cursor++] = c
      indices[cursor++] = d
    }
  }

  return { positions, normals, colors, fullColors, indices }
}

function calculateFarFieldColors(
  positions: Float32Array,
  normals: Float32Array,
  previewColors: Float32Array,
  fullColors: Float32Array,
  width: number,
  seed: number,
): void {
  const previewGrass = [0.23, 0.35, 0.2] as const
  const previewRock = [0.36, 0.32, 0.27] as const
  const previewHigh = [0.48, 0.48, 0.43] as const
  const fullGrass = [0.043, 0.072, 0.026] as const
  const fullMeadow = [0.092, 0.089, 0.041] as const
  const fullRock = [0.078, 0.073, 0.066] as const
  const fullSnow = [0.6, 0.615, 0.64] as const

  for (let z = 0; z < width; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (z * width + x) * 3
      const height = positions[offset + 1]
      const slope = clamp(1 - Math.abs(normals[offset + 1]), 0, 1)

      // Preview uses the same broad grass/rock/high blend as compiled sections,
      // so crossing the residency boundary does not introduce a new palette.
      const previewRockMix = smoothstep(0.2, 0.72, slope)
      const previewAltitude = smoothstep(20, 78, height)
      const previewVariation = 0.96 + hashVariation(x, z, seed) * 0.06
      for (let channel = 0; channel < 3; channel += 1) {
        previewColors[offset + channel] = lerp(
          lerp(previewGrass[channel], previewRock[channel], previewRockMix),
          previewHigh[channel],
          previewAltitude,
        ) * previewVariation
      }

      // At this distance the full shader's micro/meso bands have already
      // filtered to their means. Preserve its material families and broad
      // variation without running the expensive fragment synthesis over the
      // world-sized fallback mesh.
      const macro = hashVariation(x, z, seed + 431)
      const regional = hashVariation(x + 173, z - 89, seed + 977)
      const alpine = smoothstep(150, 340, height)
      const fullRockMix = Math.max(smoothstep(0.18, 0.54, slope), alpine * 0.5)
      const meadowMix = clamp(macro * 0.72 + alpine * 0.28, 0, 1)
      const snowMix =
        smoothstep(SNOW_LINE, SNOW_LINE + SNOW_LINE_BAND, height) *
        (1 - smoothstep(0.14, 0.52, slope))
      const fullVariation = 0.86 + regional * 0.2
      for (let channel = 0; channel < 3; channel += 1) {
        const ground = lerp(fullGrass[channel], fullMeadow[channel], meadowMix)
        const exposed = lerp(ground, fullRock[channel], fullRockMix)
        fullColors[offset + channel] = lerp(
          exposed,
          fullSnow[channel],
          snowMix,
        ) * fullVariation
      }
    }
  }
}

function calculateGridNormals(
  positions: Float32Array,
  normals: Float32Array,
  width: number,
): void {
  for (let z = 0; z < width; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const left = (z * width + Math.max(0, x - 1)) * 3
      const right = (z * width + Math.min(width - 1, x + 1)) * 3
      const north = (Math.max(0, z - 1) * width + x) * 3
      const south = (Math.min(width - 1, z + 1) * width + x) * 3
      const tx = {
        x: positions[right] - positions[left],
        y: positions[right + 1] - positions[left + 1],
        z: positions[right + 2] - positions[left + 2],
      }
      const tz = {
        x: positions[south] - positions[north],
        y: positions[south + 1] - positions[north + 1],
        z: positions[south + 2] - positions[north + 2],
      }
      const nx = tz.y * tx.z - tz.z * tx.y
      const ny = tz.z * tx.x - tz.x * tx.z
      const nz = tz.x * tx.y - tz.y * tx.x
      const length = Math.hypot(nx, ny, nz) || 1
      const offset = (z * width + x) * 3
      normals[offset] = nx / length
      normals[offset + 1] = ny / length
      normals[offset + 2] = nz / length
    }
  }
}

function hashVariation(x: number, z: number, seed: number): number {
  const value = Math.sin(x * 12.9898 + z * 78.233 + seed * 0.013) * 43_758.5453
  return clamp(value - Math.floor(value), 0, 1)
}
