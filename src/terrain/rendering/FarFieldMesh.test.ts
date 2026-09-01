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
    // The proxy must not be *systematically* lowered. It used to be sunk for
    // overlap prevention, which made the atmosphere treat a ridge as valley
    // floor and abruptly veil it at the residency boundary; overlap is handled
    // by clearing proxy depth before resident terrain instead.
    //
    // It is sampled band-limited to its own ~32 m grid, so it is the local mean
    // of the surface rather than a point on it and will not match exactly. That
    // is a zero-mean low-pass, not a sink, and this checks exactly that: each
    // vertex stays within the residual its own grid implies, and the mean error
    // across many of them stays near zero in both directions.
    const worldX = 768
    const worldZ = 256
    const proxyHeight = interpolateGridHeight(
      mesh.positions,
      worldSize,
      worldX,
      worldZ,
    )
    const terrainHeight = evaluateHeight(worldX, worldZ, seed, [])
    const edgeLength = worldSize / (mesh.positions.length ** 0.5 / 3 ** 0.5 - 1)
    expect(Math.abs(proxyHeight - terrainHeight)).toBeLessThan(edgeLength)

    let signedTotal = 0
    let samples = 0
    for (let probe = 0; probe < 64; probe += 1) {
      const x = -2_048 + probe * 61
      const z = 256 + probe * 37
      signedTotal +=
        interpolateGridHeight(mesh.positions, worldSize, x, z) -
        evaluateHeight(x, z, seed, [])
      samples += 1
    }
    // No systematic offset in either direction.
    expect(Math.abs(signedTotal / samples)).toBeLessThan(6)
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
