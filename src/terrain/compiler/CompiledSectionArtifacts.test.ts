import { describe, expect, it } from 'vitest'
import type { CompiledLOD, CompiledSection } from '../core/types'
import {
  mergeCompiledLevels,
  missingCompiledLevels,
  retainCompiledLevels,
} from './CompiledSectionArtifacts'

describe('compiled section artifacts', () => {
  it('prunes detail by retaining the exact coarse buffers', () => {
    const compiled = section(7, [0, 1, 2, 3, 4])
    const retained = retainCompiledLevels(compiled, [2, 3, 4])!

    expect(retained.lods.map((lod) => lod.level)).toEqual([2, 3, 4])
    expect(retained.lods[0]).toBe(compiled.lods[2])
    expect(retained.cpuBytes).toBe(
      retained.lods.reduce(
        (bytes, lod) =>
          bytes +
          lod.gpuBytes +
          lod.stableVertexIds!.byteLength +
          lod.sourceVertexIndices!.byteLength,
        0,
      ),
    )
  })

  it('merges a refinement without replacing existing coarse levels', () => {
    const coarse = section(3, [2, 3, 4])
    const refinement = section(3, [0, 1])
    const merged = mergeCompiledLevels(coarse, refinement)

    expect(merged.lods.map((lod) => lod.level)).toEqual([0, 1, 2, 3, 4])
    expect(merged.lods[2]).toBe(coarse.lods[0])
    expect(merged.lods[0]).toBe(refinement.lods[0])
  })

  it('does not merge different source revisions', () => {
    const old = section(2, [2, 3, 4])
    const current = section(3, [0, 1])
    expect(mergeCompiledLevels(old, current).lods).toEqual(current.lods)
  })

  it('reports only levels absent from the current revision', () => {
    const compiled = section(5, [2, 3, 4])
    expect(missingCompiledLevels(compiled, [0, 1, 2, 3, 4], 5)).toEqual([0, 1])
    expect(missingCompiledLevels(compiled, [0, 1, 2], 6)).toEqual([0, 1, 2])
  })
})

function section(revision: number, levels: number[]): CompiledSection {
  const lods = levels.map(lod)
  return {
    key: { x: 1, z: -2 },
    sourceRevision: revision,
    bounds: {
      min: { x: 0, y: -1, z: 0 },
      max: { x: 128, y: 1, z: 128 },
    },
    lods,
    cpuBytes: lods.reduce(
      (bytes, value) =>
        bytes +
        value.gpuBytes +
        value.stableVertexIds!.byteLength +
        value.sourceVertexIndices!.byteLength,
      0,
    ),
    gpuBytes: lods.reduce((bytes, value) => bytes + value.gpuBytes, 0),
    metadata: {
      compileMs: 1,
      vertexCount: lods[0].positions.length / 3,
      triangleCount: lods[0].triangleCount,
      density: 1,
      hasArbitraryTopology: false,
      validationWarnings: 0,
    },
  }
}

function lod(level: number): CompiledLOD {
  const vertexCount = 6 - level
  const positions = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(Math.max(3, (vertexCount - 2) * 3))
  const gpuBytes = positions.byteLength + indices.byteLength
  return {
    level,
    geometricError: level,
    positions,
    stableVertexIds: new Uint32Array(vertexCount * 2),
    sourceVertexIndices: Uint32Array.from(
      { length: vertexCount },
      (_, vertex) => vertex,
    ),
    normals: new Float32Array(vertexCount * 3),
    colors: new Float32Array(vertexCount * 3),
    indices,
    triangleCount: indices.length / 3,
    gpuBytes,
  }
}
