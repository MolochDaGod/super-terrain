import { describe, expect, it } from 'vitest'
import type { CompiledSection } from '../core/types'
import { decodeSectionBake, encodeSectionBake } from './sectionBake'

describe('section bake transport', () => {
  it('round-trips every render stream without JSON or base64 expansion', () => {
    const source = fixture()
    const [decoded] = decodeSectionBake(encodeSectionBake([source]))
    expect(decoded?.key).toEqual(source.key)
    expect(decoded?.bounds).toEqual(source.bounds)
    expect(decoded?.lods.map((lod) => lod.level)).toEqual([1])
    expect([...decoded!.lods[0]!.positions]).toEqual([...source.lods[0]!.positions])
    expect([...decoded!.lods[0]!.stableVertexIds!]).toEqual([11, 12, 13])
    expect(decoded!.lods[0]!.sourceLevel).toBe(0)
    expect([...decoded!.lods[0]!.sourceVertexIndices!]).toEqual([2, 1, 0])
    expect([...decoded!.lods[0]!.surfaceFields![4]]).toEqual([41, 42, 43, 44])
    expect([...decoded!.lods[0]!.indices]).toEqual([0, 1, 2])
    expect(decoded?.gpuBytes).toBeGreaterThan(0)
    expect(decoded?.cpuBytes).toBeGreaterThan(decoded!.gpuBytes!)
  })

  it('rejects corrupt and truncated payloads', () => {
    expect(() => decodeSectionBake(new Uint8Array([1, 2, 3, 4]))).toThrow()
    const encoded = encodeSectionBake([fixture()])
    expect(() => decodeSectionBake(encoded.slice(0, -3))).toThrow('Truncated')
  })
})

function fixture(): CompiledSection {
  const surfaceFields = [1, 2, 3, 4, 5].map((offset) =>
    new Uint16Array([offset * 8 + 1, offset * 8 + 2, offset * 8 + 3, offset * 8 + 4]),
  ) as unknown as NonNullable<CompiledSection['lods'][number]['surfaceFields']>
  return {
    key: { x: 2, z: -1 },
    sourceRevision: 0,
    bounds: {
      min: { x: 256, y: -7, z: -128 },
      max: { x: 384, y: 91, z: 0 },
    },
    lods: [{
      level: 1,
      sourceLevel: 0,
      geometricError: 2.5,
      positions: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      stableVertexIds: new Uint32Array([11, 12, 13]),
      sourceVertexIndices: new Uint32Array([2, 1, 0]),
      normals: new Float32Array(9).fill(0.5),
      colors: new Float32Array(9).fill(0.25),
      surfaceFields,
      paintWeights: new Uint16Array([1, 2, 3, 4]),
      indices: new Uint32Array([0, 1, 2]),
      triangleCount: 1,
      gpuBytes: 0,
    }],
    metadata: {
      compileMs: 1,
      vertexCount: 3,
      triangleCount: 1,
      density: 0.1,
      hasArbitraryTopology: true,
      validationWarnings: 0,
    },
    cpuBytes: 0,
    gpuBytes: 0,
  }
}
