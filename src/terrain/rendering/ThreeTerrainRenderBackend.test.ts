import { describe, expect, it } from 'vitest'
import {
  BufferAttribute,
  Group,
  Mesh,
} from 'three/webgpu'
import type { CompiledSection } from '../core/types'
import { MeshPartition } from '../partition/MeshPartition'
import { ThreeTerrainRenderBackend } from './ThreeTerrainRenderBackend'

describe('Three terrain render preview', () => {
  it('deforms the resident render mesh immediately and refreshes its bounds', () => {
    const root = new Group()
    const backend = new ThreeTerrainRenderBackend(root, 128)
    const partition = new MeshPartition({ sectionSize: 128, worldSize: 512, seed: 1 })
    const section = partition.getOrCreate({ x: 0, z: 0 })
    section.activeLod = 0
    const compiled = planeSection()
    backend.upload(section, compiled)

    backend.previewBrush({
      mode: 'raise',
      domain: 'mesh',
      samples: [
        {
          x: 5,
          y: 0,
          z: 5,
          normal: { x: 0, y: 1, z: 0 },
          weight: 1,
        },
      ],
      radius: 6,
      strength: 1,
      falloff: 0.5,
    })

    const mesh = root.children.find(
      (child) => child.userData.terrainSectionId === section.id,
    ) as Mesh
    const positions = mesh.geometry.getAttribute('position') as BufferAttribute
    expect(positions.getY(4)).toBeCloseTo(2.8, 5)
    expect(mesh.geometry.boundingBox?.max.y).toBeGreaterThan(2.7)
    expect((mesh.geometry.getAttribute('normal') as BufferAttribute).version).toBeGreaterThan(0)
    backend.dispose()
  })
})

function planeSection(): CompiledSection {
  const positions = new Float32Array([
    0, 0, 0, 5, 0, 0, 10, 0, 0,
    0, 0, 5, 5, 0, 5, 10, 0, 5,
    0, 0, 10, 5, 0, 10, 10, 0, 10,
  ])
  const indices = new Uint32Array([
    0, 3, 1, 1, 3, 4,
    1, 4, 2, 2, 4, 5,
    3, 6, 4, 4, 6, 7,
    4, 7, 5, 5, 7, 8,
  ])
  return {
    key: { x: 0, z: 0 },
    sourceRevision: 0,
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 0, z: 10 },
    },
    lods: [
      {
        level: 0,
        geometricError: 0.1,
        positions,
        normals: new Float32Array(
          Array.from({ length: 9 }, () => [0, 1, 0]).flat(),
        ),
        colors: new Float32Array(
          Array.from({ length: 9 }, () => [0.2, 0.3, 0.2]).flat(),
        ),
        indices,
        triangleCount: indices.length / 3,
        gpuBytes: positions.byteLength + indices.byteLength,
      },
    ],
    cpuBytes: positions.byteLength + indices.byteLength,
    metadata: {
      compileMs: 0,
      vertexCount: 9,
      triangleCount: indices.length / 3,
      density: 0.09,
      hasArbitraryTopology: false,
      validationWarnings: 0,
    },
  }
}
