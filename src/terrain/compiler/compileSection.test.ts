import { describe, expect, it } from 'vitest'
import {
  createBooleanVolumeModifier,
  createBrushStroke,
  createRemeshModifier,
  createTunnelModifier,
} from '../modifiers/factories'
import type { TerrainModifier } from '../modifiers/types'
import { encodeModifiers, type CompileSectionRequest } from '../workers/protocol'
import { compileTerrainSection, evaluateHeight } from './compileSection'

function requestWithTunnel(includeTunnel: boolean): CompileSectionRequest {
  const center = { x: 54, y: evaluateHeight(54, 52, 17, []), z: 52 }
  return {
    kind: 'compile-section',
    jobId: 1,
    key: { x: 0, z: 0 },
    revision: 3,
    priority: 1,
    config: {
      sectionSize: 128,
      lodResolutions: [10, 7, 4],
      seed: 17,
      operationHalo: 8,
    },
    modifiers: encodeModifiers(
      includeTunnel
        ? [createTunnelModifier({ center, radius: 7, length: 42 })]
        : [],
    ),
  }
}

function requestFor(
  key: { x: number; z: number },
  modifiers: TerrainModifier[],
  resolution = 8,
): CompileSectionRequest {
  return {
    kind: 'compile-section',
    jobId: 2,
    key,
    revision: 1,
    priority: 1,
    config: {
      sectionSize: 128,
      lodResolutions: [resolution],
      seed: 17,
      operationHalo: 8,
    },
    modifiers: encodeModifiers(modifiers),
  }
}

describe('section compiler', () => {
  it('is deterministic for procedural source and modifier inputs', () => {
    const first = compileTerrainSection(requestWithTunnel(false))
    const second = compileTerrainSection(requestWithTunnel(false))
    expect(first.lods.map((lod) => lod.positions)).toEqual(
      second.lods.map((lod) => lod.positions),
    )
    expect(first.lods.map((lod) => lod.indices)).toEqual(
      second.lods.map((lod) => lod.indices),
    )
  })

  it('emits genuine non-heightfield tunnel topology', () => {
    const base = compileTerrainSection(requestWithTunnel(false))
    const tunnel = compileTerrainSection(requestWithTunnel(true))
    expect(tunnel.metadata.hasArbitraryTopology).toBe(true)
    expect(tunnel.metadata.vertexCount).toBeGreaterThan(base.metadata.vertexCount)
    expect(tunnel.lods).toHaveLength(3)
    expect(tunnel.metadata.validationWarnings).toBe(0)

    for (const lod of tunnel.lods) {
      const elevationsByPlanarPoint = new Map<string, Set<number>>()
      for (let index = 0; index < lod.positions.length; index += 3) {
        const key = `${lod.positions[index].toFixed(2)}:${lod.positions[index + 2].toFixed(2)}`
        const heights = elevationsByPlanarPoint.get(key) ?? new Set<number>()
        heights.add(Math.round(lod.positions[index + 1] * 100))
        elevationsByPlanarPoint.set(key, heights)
      }
      expect(
        [...elevationsByPlanarPoint.values()].some(
          (heights) => heights.size > 1,
        ),
      ).toBe(true)
    }
  })

  it('subtracts an arbitrary closed volume without deleting the section', () => {
    const center = { x: 54, y: evaluateHeight(54, 52, 17, []), z: 52 }
    const volume = createBooleanVolumeModifier({
      volumes: [
        {
          kind: 'ellipsoid',
          center,
          radii: { x: 14, y: 9, z: 11 },
          forward: { x: 1, y: 0, z: 0.2 },
          surface: 'cave',
        },
      ],
    })
    const base = compileTerrainSection(requestFor({ x: 0, z: 0 }, [], 12))
    const carved = compileTerrainSection(requestFor({ x: 0, z: 0 }, [volume], 12))

    expect(carved.metadata.hasArbitraryTopology).toBe(true)
    expect(carved.metadata.validationWarnings).toBe(0)
    expect(carved.metadata.vertexCount).toBeGreaterThan(base.metadata.vertexCount)
    expect(carved.lods[0].triangleCount).toBeGreaterThan(0)
    expect(carved.bounds.max.x - carved.bounds.min.x).toBeCloseTo(128, 4)
    expect(carved.bounds.max.z - carved.bounds.min.z).toBeCloseTo(128, 4)
  })

  it('does not stretch a section toward a density modifier that only touches its halo', () => {
    const adjacentDensity = createRemeshModifier({
      center: { x: 150, y: 0, z: 64 },
      radius: 10,
      targetEdgeLength: 0.75,
    })
    const base = compileTerrainSection(requestFor({ x: 0, z: 0 }, [], 12))
    const compiled = compileTerrainSection(
      requestFor({ x: 0, z: 0 }, [adjacentDensity], 12),
    )

    expect(compiled.bounds.min.x).toBeCloseTo(0, 6)
    expect(compiled.bounds.max.x).toBeCloseTo(128, 6)
    expect(compiled.lods[0].positions).toEqual(base.lods[0].positions)
    expect(compiled.lods[0].indices).toEqual(base.lods[0].indices)
  })

  it('retains a localized mesh sculpt in every simplified LOD', () => {
    const point = { x: 40, y: evaluateHeight(40, 40, 17, []), z: 40 }
    const stroke = createBrushStroke({
      point,
      normal: { x: 1, y: 0, z: 0 },
      domain: 'mesh',
      mode: 'raise',
      radius: 5,
      strength: 1,
      falloff: 0.5,
    })
    const request = requestFor({ x: 0, z: 0 }, [stroke], 16)
    request.config.lodResolutions = [16, 8, 4]
    const compiled = compileTerrainSection(request)

    expect(compiled.lods[2].triangleCount).toBeLessThan(
      compiled.lods[0].triangleCount,
    )
    for (const lod of compiled.lods) {
      expect(retainsSculptPeak(lod.positions, point.x, point.z)).toBe(true)
    }

    request.levels = [2]
    const distantOnly = compileTerrainSection(request)
    expect(distantOnly.metadata.vertexCount).toBe(17 * 17)
    expect(distantOnly.lods[0].level).toBe(2)
    expect(
      retainsSculptPeak(distantOnly.lods[0].positions, point.x, point.z),
    ).toBe(true)
  })

  it('keeps the authoritative border and its shading in every LOD', () => {
    const request = requestFor({ x: 0, z: 0 }, [], 16)
    request.config.lodResolutions = [16, 8, 4]
    const lods = compileTerrainSection(request).lods
    const authoritative = boundaryVertices(lods[0])

    expect(lods[1].triangleCount).toBeLessThan(lods[0].triangleCount)
    expect(lods[2].triangleCount).toBeLessThan(lods[1].triangleCount)
    for (const lod of lods.slice(1)) {
      expect(boundaryVertices(lod)).toEqual(authoritative)
    }
  })

  it('skips hidden fine topology for a procedural single-LOD request', () => {
    const request = requestFor({ x: 0, z: 0 }, [], 16)
    request.config.lodResolutions = [16, 8, 4]
    request.levels = [2]
    const compiled = compileTerrainSection(request)

    expect(compiled.lods).toHaveLength(1)
    expect(compiled.lods[0].level).toBe(2)
    expect(compiled.metadata.vertexCount).toBe(25)
    expect(compiled.lods[0].triangleCount).toBe(32)
  })

  it('keeps heightfield strokes on Y and lets mesh strokes deform XZ', () => {
    const point = { x: 64, y: evaluateHeight(64, 64, 17, []), z: 64 }
    const heightStroke = createBrushStroke({
      point,
      normal: { x: 1, y: 0, z: 0 },
      domain: 'heightfield',
      mode: 'raise',
      radius: 24,
      strength: 1,
      falloff: 0.5,
    })
    const meshStroke = createBrushStroke({
      point,
      normal: { x: 1, y: 0, z: 0 },
      domain: 'mesh',
      mode: 'raise',
      radius: 24,
      strength: 1,
      falloff: 0.5,
    })
    const height = compileTerrainSection(requestFor({ x: 0, z: 0 }, [heightStroke]))
    const mesh = compileTerrainSection(requestFor({ x: 0, z: 0 }, [meshStroke]))
    const centerOffset = (4 * 9 + 4) * 3

    expect(height.lods[0].positions[centerOffset]).toBeCloseTo(64, 5)
    expect(height.lods[0].positions[centerOffset + 1]).toBeGreaterThan(point.y)
    expect(mesh.lods[0].positions[centerOffset]).toBeGreaterThan(66)
    expect(mesh.lods[0].positions[centerOffset + 1]).toBeCloseTo(point.y, 5)
    expect(mesh.metadata.hasArbitraryTopology).toBe(true)
  })

  it('emits identical positions and normals on shared section boundaries', () => {
    const point = { x: 128, y: evaluateHeight(128, 64, 17, []), z: 64 }
    const stroke = createBrushStroke({
      point,
      normal: { x: 0.6, y: 0.8, z: 0 },
      domain: 'mesh',
      mode: 'raise',
      radius: 34,
      strength: 0.7,
      falloff: 0.45,
    })
    const west = compileTerrainSection(requestFor({ x: 0, z: 0 }, [stroke]))
    const east = compileTerrainSection(requestFor({ x: 1, z: 0 }, [stroke]))
    const resolution = 8
    for (let row = 0; row <= resolution; row += 1) {
      const westVertex = (row * (resolution + 1) + resolution) * 3
      const eastVertex = row * (resolution + 1) * 3
      for (let axis = 0; axis < 3; axis += 1) {
        const westPosition = west.lods[0].positions[westVertex + axis]
        const eastPosition = Math.fround(
          east.lods[0].positions[eastVertex + axis] + (axis === 0 ? 128 : 0),
        )
        expect(Math.fround(westPosition)).toBe(eastPosition)
        expect(west.lods[0].normals[westVertex + axis]).toBeCloseTo(
          east.lods[0].normals[eastVertex + axis],
          5,
        )
      }
    }
  })

  it('keeps shared samples and shading identical across nested LOD boundaries', () => {
    const point = { x: 128, y: evaluateHeight(128, 64, 17, []), z: 64 }
    const stroke = createBrushStroke({
      point,
      normal: { x: 0.55, y: 0.8, z: 0.23 },
      domain: 'mesh',
      mode: 'raise',
      radius: 38,
      strength: 0.62,
      falloff: 0.5,
    })
    const fine = compileTerrainSection(
      requestFor({ x: 0, z: 0 }, [stroke], 16),
    ).lods[0]
    const coarse = compileTerrainSection(
      requestFor({ x: 1, z: 0 }, [stroke], 8),
    ).lods[0]

    for (let coarseRow = 0; coarseRow <= 8; coarseRow += 1) {
      const fineRow = coarseRow * 2
      const fineVertex = (fineRow * 17 + 16) * 3
      const coarseVertex = coarseRow * 9 * 3
      for (let axis = 0; axis < 3; axis += 1) {
        const finePosition = Math.fround(fine.positions[fineVertex + axis])
        const coarsePosition = Math.fround(
          coarse.positions[coarseVertex + axis] + (axis === 0 ? 128 : 0),
        )
        expect(finePosition).toBe(coarsePosition)
        expect(fine.normals[fineVertex + axis]).toBeCloseTo(
          coarse.normals[coarseVertex + axis],
          6,
        )
        expect(fine.colors[fineVertex + axis]).toBeCloseTo(
          coarse.colors[coarseVertex + axis],
          6,
        )
      }
    }
  })
})

function boundaryVertices(lod: {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  surfaceFields?: readonly Uint16Array[]
}): Map<string, number[]> {
  const boundary = new Map<string, number[]>()
  for (let offset = 0; offset < lod.positions.length; offset += 3) {
    const x = lod.positions[offset]
    const z = lod.positions[offset + 2]
    if (x !== 0 && x !== 128 && z !== 0 && z !== 128) continue
    const values = [
      lod.positions[offset + 1],
      lod.normals[offset],
      lod.normals[offset + 1],
      lod.normals[offset + 2],
      lod.colors[offset],
      lod.colors[offset + 1],
      lod.colors[offset + 2],
    ]
    const fieldOffset = (offset / 3) * 4
    for (const field of lod.surfaceFields ?? []) {
      values.push(
        field[fieldOffset],
        field[fieldOffset + 1],
        field[fieldOffset + 2],
        field[fieldOffset + 3],
      )
    }
    boundary.set(`${x}:${z}`, values)
  }
  return boundary
}

function retainsSculptPeak(
  positions: Float32Array,
  sourceX: number,
  sourceZ: number,
): boolean {
  for (let offset = 0; offset < positions.length; offset += 3) {
    if (
      Math.abs(positions[offset + 2] - sourceZ) < 1e-4 &&
      positions[offset] > sourceX + 2.5 &&
      positions[offset] < sourceX + 3.1
    ) {
      return true
    }
  }
  return false
}
