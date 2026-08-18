import { describe, expect, it } from 'vitest'
import { evaluateHeight } from '../compiler/TerrainField'
import { generateFarFieldMesh } from './FarFieldMesh'

describe('far-field terrain mesh', () => {
  it('builds a finite elevated world proxy with upward normals', () => {
    const mesh = generateFarFieldMesh(16_384, 13_371)
    expect(mesh.positions.length / 3).toBe(257 * 257)
    expect(mesh.indices.length / 3).toBe(256 * 256 * 2)
    expect(mesh.positions.every(Number.isFinite)).toBe(true)
    expect(mesh.normals.every(Number.isFinite)).toBe(true)
    expect(mesh.colors.every(Number.isFinite)).toBe(true)
    expect(mesh.fullColors.every(Number.isFinite)).toBe(true)
    expect(mesh.fullColors.length).toBe(mesh.colors.length)
    let upward = 0
    for (let offset = 1; offset < mesh.normals.length; offset += 3) {
      if (mesh.normals[offset] > 0) upward += 1
    }
    expect(upward).toBe(mesh.normals.length / 3)
  })

  it('keeps the true elevation for lighting and height-based haze', () => {
    const worldSize = 16_384
    const seed = 13_371
    const mesh = generateFarFieldMesh(worldSize, seed)
    // This is a grid vertex in the denser proxy. It used to be lowered solely
    // for overlap prevention, which made the atmosphere treat the ridge as
    // valley floor and abruptly veil it at the residency boundary. Overlap is
    // now handled by the resident/proxy stencil mask instead.
    const worldX = 768
    const worldZ = 256
    const proxyHeight = interpolateGridHeight(
      mesh.positions,
      worldSize,
      worldX,
      worldZ,
    )
    const terrainHeight = evaluateHeight(worldX, worldZ, seed, [])

    expect(proxyHeight).toBeCloseTo(terrainHeight, 4)
  })

  it('uses a lower full-mode albedo instead of the washed preview palette', () => {
    const mesh = generateFarFieldMesh(16_384, 13_371)
    let previewLuminance = 0
    let fullLuminance = 0
    for (let offset = 0; offset < mesh.colors.length; offset += 3) {
      previewLuminance += luminance(mesh.colors, offset)
      fullLuminance += luminance(mesh.fullColors, offset)
    }
    expect(fullLuminance).toBeLessThan(previewLuminance * 0.75)
  })
})

function luminance(colors: Float32Array, offset: number): number {
  return (
    colors[offset] * 0.2126 +
    colors[offset + 1] * 0.7152 +
    colors[offset + 2] * 0.0722
  )
}

function interpolateGridHeight(
  positions: Float32Array,
  worldSize: number,
  worldX: number,
  worldZ: number,
): number {
  const width = Math.round(Math.sqrt(positions.length / 3))
  const segments = width - 1
  const gridX = ((worldX + worldSize * 0.5) / worldSize) * segments
  const gridZ = ((worldZ + worldSize * 0.5) / worldSize) * segments
  const x = Math.min(segments - 1, Math.max(0, Math.floor(gridX)))
  const z = Math.min(segments - 1, Math.max(0, Math.floor(gridZ)))
  const u = gridX - x
  const v = gridZ - z
  const height = (vertexX: number, vertexZ: number) =>
    positions[(vertexZ * width + vertexX) * 3 + 1]
  const a = height(x, z)
  const b = height(x + 1, z)
  const c = height(x, z + 1)
  const d = height(x + 1, z + 1)

  return u + v <= 1
    ? a + (b - a) * u + (c - a) * v
    : d + (c - d) * (1 - u) + (b - d) * (1 - v)
}
