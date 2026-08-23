import { describe, expect, it } from 'vitest'
import {
  BufferAttribute,
  Group,
  Mesh,
} from 'three/webgpu'
import type { CompiledSection } from '../core/types'
import { MeshPartition } from '../partition/MeshPartition'
import { BRUSH_DEPTH_PER_RADIUS } from '../modifiers/brushKernel'
import { appendBrushPoint, createBrushStroke } from '../modifiers/factories'
import { evaluateEditableTerrainPoint } from '../compiler/TerrainField'
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

    const mesh = root.getObjectByName(`terrain-section-${section.id}`) as Mesh
    const positions = mesh.geometry.getAttribute('position') as BufferAttribute
    // One full-weight dab lifts the surface by a fixed fraction of the brush
    // radius, so the preview reports exactly what the compiler will produce.
    const peak = 6 * BRUSH_DEPTH_PER_RADIUS
    expect(positions.getY(4)).toBeCloseTo(peak, 5)
    expect(mesh.geometry.boundingBox?.max.y).toBeGreaterThan(peak - 0.1)
    expect((mesh.geometry.getAttribute('normal') as BufferAttribute).version).toBeGreaterThan(0)
    backend.dispose()
  })

  it('previews exactly what the compiler will evaluate for the same stroke', () => {
    const root = new Group()
    const backend = new ThreeTerrainRenderBackend(root, 128)
    const partition = new MeshPartition({ sectionSize: 128, worldSize: 512, seed: 1 })
    const section = partition.getOrCreate({ x: 0, z: 0 })
    section.activeLod = 0
    backend.upload(section, planeSection())
    const mesh = root.getObjectByName(`terrain-section-${section.id}`) as Mesh
    const positions = mesh.geometry.getAttribute('position') as BufferAttribute
    const source = Float32Array.from(positions.array)

    const stroke = createBrushStroke({
      point: { x: 5, y: 0, z: 5 },
      normal: { x: 0, y: 1, z: 0 },
      domain: 'mesh',
      mode: 'clay',
      radius: 7,
      strength: 0.6,
      falloff: 0.35,
      sampleWeight: 0.4,
    })
    appendBrushPoint(stroke, { x: 7, y: 0, z: 5 }, { x: 0, y: 1, z: 0 }, 0.4)

    backend.previewBrush({
      mode: stroke.mode,
      domain: stroke.domain,
      samples: stroke.points,
      radius: stroke.radius,
      strength: stroke.strength,
      falloff: stroke.falloff,
      noiseSeed: stroke.noiseSeed,
    })

    // The viewport and the worker are two evaluations of one kernel. If they
    // ever diverge the surface visibly jumps when a stroke commits, which is
    // exactly what a sculpt gesture must never do.
    let moved = 0
    for (let vertex = 0; vertex < positions.count; vertex += 1) {
      const compiled = evaluateEditableTerrainPoint(
        {
          x: source[vertex * 3],
          y: source[vertex * 3 + 1],
          z: source[vertex * 3 + 2],
        },
        { x: 0, y: 1, z: 0 },
        [stroke],
      )
      expect(positions.getX(vertex)).toBeCloseTo(compiled.x, 4)
      expect(positions.getY(vertex)).toBeCloseTo(compiled.y, 4)
      expect(positions.getZ(vertex)).toBeCloseTo(compiled.z, 4)
      if (compiled.y !== source[vertex * 3 + 1]) moved += 1
    }
    expect(moved).toBeGreaterThan(0)
    backend.dispose()
  })

  it('weight-paints only intersecting resident topology buffers', () => {
    const root = new Group()
    const backend = new ThreeTerrainRenderBackend(root, 128)
    const partition = new MeshPartition({ sectionSize: 128, worldSize: 2048, seed: 1 })
    const near = partition.getOrCreate({ x: 0, z: 0 })
    const far = partition.getOrCreate({ x: 4, z: 4 })
    backend.upload(near, planeSection())
    backend.upload(far, planeSection())

    backend.previewWeightPaint({
      channel: 'channel2',
      mode: 'add',
      samples: [{
        x: 5,
        y: 0,
        z: 5,
        normal: { x: 0, y: 1, z: 0 },
        weight: 1,
      }],
      radius: 6,
      strength: 1,
      falloff: 0.5,
    })

    const nearMesh = root.getObjectByName(`terrain-section-${near.id}`) as Mesh
    const farMesh = root.getObjectByName(`terrain-section-${far.id}`) as Mesh
    const nearWeights = nearMesh.geometry.getAttribute(
      'terrainPaintWeights',
    ) as BufferAttribute
    const farWeights = farMesh.geometry.getAttribute(
      'terrainPaintWeights',
    ) as BufferAttribute
    expect((nearWeights.array as Uint16Array)[4 * 4 + 2]).toBe(65_535)
    expect(nearWeights.version).toBeGreaterThan(0)
    expect(nearWeights.updateRanges.length).toBeGreaterThan(0)
    expect(farWeights.version).toBe(0)
    expect([...farWeights.array as Uint16Array].every((value) => value === 0)).toBe(true)
    backend.dispose()
  })
})

describe('Three terrain far-field batching', () => {
  const uploadCoarseCell = () => {
    const root = new Group()
    const backend = new ThreeTerrainRenderBackend(root, 128)
    const partition = new MeshPartition({ sectionSize: 128, worldSize: 2048, seed: 1 })
    const sections = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 0, z: 1 },
      { x: 1, z: 1 },
    ].map((key) => {
      const section = partition.getOrCreate(key)
      section.requestedLod = 2
      backend.upload(section, planeSection(2))
      return section
    })
    return { root, backend, sections }
  }

  it('merges settled coarse sections into one draw at their world offsets', () => {
    const { root, backend, sections } = uploadCoarseCell()
    const single = (root.getObjectByName(
      `terrain-section-${sections[0].id}`,
    ) as Mesh).geometry
    const singleVertices = single.getAttribute('position').count
    const singleIndices = single.getIndex()?.count ?? 0
    expect(backend.flushSectionBatches(performance.now() + 1_000, 4)).toBe(1)

    const merged = root.children
      .flatMap((child) => child.children)
      .filter((child): child is Mesh => child.name.startsWith('terrain-batch-'))
    expect(merged).toHaveLength(1)
    for (const section of sections) {
      expect(root.getObjectByName(`terrain-section-${section.id}`)).toBeUndefined()
    }

    const positions = merged[0].geometry.getAttribute('position') as BufferAttribute
    expect(positions.count).toBe(4 * singleVertices)
    // Section 1:1 contributes the far corner, offset by a section on both axes.
    const xs = [...(positions.array as Float32Array).filter((_, index) => index % 3 === 0)]
    expect(Math.max(...xs)).toBeCloseTo(128 + 10, 5)
    // Triangle count is unchanged: this replaces draws, never geometry.
    expect(merged[0].geometry.getIndex()?.count).toBe(4 * singleIndices)
    backend.dispose()
  })

  it('returns members to their own draws as soon as one of them changes', () => {
    const { root, backend, sections } = uploadCoarseCell()
    backend.flushSectionBatches(performance.now() + 1_000, 4)

    backend.setVisible(sections[0].id, false)

    expect(
      root.children
        .flatMap((child) => child.children)
        .filter((child) => child.name.startsWith('terrain-batch-')),
    ).toHaveLength(0)
    for (const section of sections) {
      expect(root.getObjectByName(`terrain-section-${section.id}`)).toBeDefined()
    }
    expect(root.getObjectByName(`terrain-section-${sections[0].id}`)?.visible).toBe(false)
    backend.dispose()
  })

  it('leaves the editable near field alone', () => {
    const root = new Group()
    const backend = new ThreeTerrainRenderBackend(root, 128)
    const partition = new MeshPartition({ sectionSize: 128, worldSize: 2048, seed: 1 })
    for (const key of [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: 1, z: 1 }]) {
      backend.upload(partition.getOrCreate(key), planeSection(0))
    }
    expect(backend.flushSectionBatches(performance.now() + 1_000, 4)).toBe(0)
    backend.dispose()
  })
})

function planeSection(level = 0): CompiledSection {
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
        level,
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
