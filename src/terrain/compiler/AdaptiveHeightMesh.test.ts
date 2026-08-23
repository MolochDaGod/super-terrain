import { describe, expect, it } from 'vitest'
import { validateMeshData } from '../mesh/MeshValidation'
import { createErrorBoundedHeightMesh } from './AdaptiveHeightMesh'

describe('error-bounded adaptive height mesh', () => {
  it('collapses planar interiors while preserving the authoritative boundary', () => {
    const mesh = createErrorBoundedHeightMesh({
      originX: 0,
      originZ: 0,
      size: 128,
      resolution: 16,
      errorTolerance: 0.01,
      evaluate: (x, z) => ({ x, y: x * 0.1 + z * 0.05, z }),
    })!

    expect(mesh.positions.length / 3).toBeLessThan(mesh.baselineVertexCount)
    expect(mesh.sampledError).toBeLessThanOrEqual(0.01)
    expect(validateMeshData(mesh.positions, mesh.indices).valid).toBe(true)

    const boundary = new Set<string>()
    for (let vertex = 0; vertex < mesh.parameters.length / 2; vertex += 1) {
      const x = mesh.parameters[vertex * 2]
      const z = mesh.parameters[vertex * 2 + 1]
      if (x === 0 || x === 128 || z === 0 || z === 128) {
        boundary.add(`${x}:${z}`)
      }
    }
    expect(boundary.size).toBe(16 * 4)
  })

  it('retains more cells around curvature without exceeding the sampled error', () => {
    const plane = createErrorBoundedHeightMesh({
      originX: 0,
      originZ: 0,
      size: 128,
      resolution: 16,
      errorTolerance: 0.15,
      evaluate: (x, z) => ({ x, y: 0, z }),
    })!
    const curved = createErrorBoundedHeightMesh({
      originX: 0,
      originZ: 0,
      size: 128,
      resolution: 16,
      errorTolerance: 0.15,
      evaluate: (x, z) => ({
        x,
        y: Math.exp(-((x - 64) ** 2 + (z - 64) ** 2) / 180) * 18,
        z,
      }),
    })!

    expect(curved.positions.length).toBeGreaterThan(plane.positions.length)
    expect(curved.sampledError).toBeLessThanOrEqual(0.15)
    expect(validateMeshData(curved.positions, curved.indices).valid).toBe(true)
  })
})
