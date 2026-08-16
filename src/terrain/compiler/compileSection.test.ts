import { describe, expect, it } from 'vitest'
import {
  createBrushStroke,
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
    expect(first.lods[0].positions).toEqual(second.lods[0].positions)
    expect(first.lods[0].indices).toEqual(second.lods[0].indices)
  })

  it('emits genuine non-heightfield tunnel topology', () => {
    const base = compileTerrainSection(requestWithTunnel(false))
    const tunnel = compileTerrainSection(requestWithTunnel(true))
    expect(tunnel.metadata.hasArbitraryTopology).toBe(true)
    expect(tunnel.metadata.vertexCount).toBeGreaterThan(base.metadata.vertexCount)
    expect(tunnel.lods).toHaveLength(3)
    expect(tunnel.metadata.validationWarnings).toBe(0)

    const positions = tunnel.lods[0].positions
    const elevationsByPlanarPoint = new Map<string, Set<number>>()
    for (let index = 0; index < positions.length; index += 3) {
      const key = `${positions[index].toFixed(2)}:${positions[index + 2].toFixed(2)}`
      const heights = elevationsByPlanarPoint.get(key) ?? new Set<number>()
      heights.add(Math.round(positions[index + 1] * 100))
      elevationsByPlanarPoint.set(key, heights)
    }
    expect([...elevationsByPlanarPoint.values()].some((heights) => heights.size > 1)).toBe(true)
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
