import { clamp, lerp, smoothstep } from '../core/bounds'
import { evaluateHeight } from '../compiler/TerrainField'

export interface FarFieldMeshData {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  indices: Uint32Array
}

const FAR_FIELD_SEGMENTS = 96
const FAR_FIELD_DEPTH_OFFSET = 34

export function generateFarFieldMesh(
  worldSize: number,
  seed: number,
): FarFieldMeshData {
  const width = FAR_FIELD_SEGMENTS + 1
  const vertexCount = width * width
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const colors = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(FAR_FIELD_SEGMENTS * FAR_FIELD_SEGMENTS * 6)
  const half = worldSize * 0.5

  for (let z = 0; z < width; z += 1) {
    const worldZ = -half + (z / FAR_FIELD_SEGMENTS) * worldSize
    for (let x = 0; x < width; x += 1) {
      const worldX = -half + (x / FAR_FIELD_SEGMENTS) * worldSize
      const vertex = z * width + x
      const offset = vertex * 3
      const height = evaluateHeight(worldX, worldZ, seed, []) - FAR_FIELD_DEPTH_OFFSET
      positions[offset] = worldX
      positions[offset + 1] = height
      positions[offset + 2] = worldZ

      const altitude = smoothstep(-28, 52, height)
      const variation = 0.92 + hashVariation(x, z, seed) * 0.08
      colors[offset] = lerp(0.12, 0.22, altitude) * variation
      colors[offset + 1] = lerp(0.2, 0.28, altitude) * variation
      colors[offset + 2] = lerp(0.16, 0.22, altitude) * variation
    }
  }

  calculateGridNormals(positions, normals, width)
  let cursor = 0
  for (let z = 0; z < FAR_FIELD_SEGMENTS; z += 1) {
    for (let x = 0; x < FAR_FIELD_SEGMENTS; x += 1) {
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

  return { positions, normals, colors, indices }
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
