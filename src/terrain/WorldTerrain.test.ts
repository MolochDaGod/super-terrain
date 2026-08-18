import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorStore } from './editor/EditorStore'
import { EditableMesh } from './mesh/EditableMesh'
import type { TerrainStorage } from './persistence/TerrainStorage'
import type { TerrainRenderBackend } from './rendering/TerrainRenderBackend'
import { WorldTerrain } from './WorldTerrain'
import { graniteMassingPreset } from './rocks/types'

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}

const memoryStorage: TerrainStorage = {
  async load() {
    return undefined
  },
  async save() {},
  async clear() {},
}

describe('world terrain brush sessions', () => {
  const OriginalWorker = globalThis.Worker

  beforeEach(() => {
    globalThis.Worker = FakeWorker as unknown as typeof Worker
  })

  afterEach(() => {
    globalThis.Worker = OriginalWorker
  })

  it('stores one uninterrupted press and drag as one modifier', () => {
    const terrain = new WorldTerrain({ workerCount: 1 }, memoryStorage)
    const previewBrush = vi.fn()
    terrain.attachRenderer(fakeRenderer(previewBrush))
    const editor = new EditorStore()
    editor.patch({ tool: 'raise', brushDomain: 'mesh', brushRadius: 10 })
    const snapshot = editor.getSnapshot()
    const firstId = terrain.beginStroke(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      snapshot,
    )
    const repeatedId = terrain.beginStroke(
      { x: 2, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      snapshot,
    )
    const initial = terrain.modifiers.snapshot()[0]
    const initialWeight = initial.type === 'brush-stroke' ? initial.points[0].weight : 0
    terrain.advanceActiveStroke(1 / 60)
    terrain.continueStroke(
      { x: 8, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    )

    const active = terrain.modifiers.snapshot()[0]
    expect(active.type).toBe('brush-stroke')
    if (active.type === 'brush-stroke') {
      expect(active.points[0].weight).toBeGreaterThan(initialWeight)
    }
    expect(previewBrush).toHaveBeenCalledTimes(3)
    expect(repeatedId).toBe(firstId)
    expect(terrain.modifiers.count).toBe(1)
    const [stroke] = terrain.modifiers.snapshot()
    expect(stroke.type).toBe('brush-stroke')
    if (stroke.type === 'brush-stroke') expect(stroke.points.length).toBeGreaterThan(1)

    terrain.endStroke()
    terrain.beginStroke(
      { x: 12, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      snapshot,
    )
    expect(terrain.modifiers.count).toBe(2)
    terrain.dispose()
  })

  it('accumulates held-brush flow in small frame-scaled increments', () => {
    const terrain = new WorldTerrain({ workerCount: 1 }, memoryStorage)
    const previewBrush = vi.fn<TerrainRenderBackend['previewBrush']>()
    terrain.attachRenderer(fakeRenderer(previewBrush))
    const editor = new EditorStore()
    editor.patch({ tool: 'raise', brushDomain: 'mesh', brushRadius: 12 })
    terrain.beginStroke(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      editor.getSnapshot(),
    )

    for (let frame = 0; frame < 30; frame += 1) {
      terrain.advanceActiveStroke(1 / 60)
    }

    const stroke = terrain.modifiers.snapshot()[0]
    expect(stroke.type).toBe('brush-stroke')
    if (stroke.type === 'brush-stroke') {
      const totalWeight = stroke.points.reduce(
        (total, sample) => total + sample.weight,
        0,
      )
      expect(totalWeight).toBeCloseTo(1.28, 5)
      expect(Math.max(...stroke.points.map((sample) => sample.weight))).toBeLessThanOrEqual(0.2)
    }
    const frameDab = previewBrush.mock.calls.at(-1)?.[0].samples[0]
    expect(frameDab?.weight).toBeCloseTo(0.04, 5)
    terrain.endStroke()
    terrain.dispose()
  })

  it('keeps weight painting on the direct buffer path until stroke end', () => {
    const terrain = new WorldTerrain({ workerCount: 1 }, memoryStorage)
    const previewBrush = vi.fn<TerrainRenderBackend['previewBrush']>()
    const previewWeightPaint = vi.fn<TerrainRenderBackend['previewWeightPaint']>()
    terrain.attachRenderer(fakeRenderer(previewBrush, previewWeightPaint))
    const editor = new EditorStore()
    editor.patch({ tool: 'paint', brushRadius: 10 })

    terrain.beginStroke(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      editor.getSnapshot(),
    )
    const revisionDuringStroke = terrain.modifiers.sourceRevision
    terrain.continueStroke(
      { x: 8, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    )
    terrain.advanceActiveStroke(1 / 60)

    expect(terrain.partition.sections.size).toBe(0)
    expect(terrain.modifiers.sourceRevision).toBe(revisionDuringStroke)
    expect(previewWeightPaint).toHaveBeenCalledTimes(3)

    terrain.endStroke()
    expect(terrain.partition.sections.size).toBeGreaterThan(0)
    expect(terrain.modifiers.sourceRevision).toBe(revisionDuringStroke + 1)
    for (const section of terrain.partition.values()) {
      expect(section.revision).toBe(1)
    }
    terrain.dispose()
  })

  it('authors a tunnel by dragging between two surface portals', () => {
    const terrain = new WorldTerrain({ workerCount: 1 }, memoryStorage)
    const editor = new EditorStore()
    editor.patch({ tool: 'tunnel', tunnelRadius: 6, tunnelDepth: 11 })
    const id = terrain.beginStroke(
      { x: 8, y: 20, z: 12 },
      { x: 0, y: 1, z: 0 },
      editor.getSnapshot(),
    )

    expect(id).toBeDefined()
    expect(terrain.modifiers.count).toBe(1)
    terrain.continueStroke(
      { x: 42, y: 24, z: 35 },
      { x: 0.2, y: 0.96, z: 0.1 },
    )
    const result = terrain.endStroke()
    const tunnel = terrain.modifiers.snapshot()[0]

    expect(result).toBe('committed')
    expect(tunnel.type).toBe('boolean-subtract')
    if (tunnel.type === 'boolean-subtract') {
      expect(tunnel.portals[0]).toMatchObject({ x: 8, y: 20, z: 12 })
      expect(tunnel.portals[1]).toMatchObject({ x: 42, y: 24, z: 35 })
      expect(tunnel.radius).toBe(6)
      expect(tunnel.depth).toBe(11)
    }
    terrain.dispose()
  })

  it('cancels a tunnel click that never defines a second portal', () => {
    const terrain = new WorldTerrain({ workerCount: 1 }, memoryStorage)
    const editor = new EditorStore()
    editor.patch({ tool: 'tunnel', tunnelRadius: 8 })
    terrain.beginStroke(
      { x: 5, y: 12, z: 7 },
      { x: 0, y: 1, z: 0 },
      editor.getSnapshot(),
    )

    expect(terrain.endStroke()).toBe('cancelled')
    expect(terrain.modifiers.count).toBe(0)
    terrain.dispose()
  })

  it('owns arbitrary section source meshes without exposing mutable internals', () => {
    const terrain = new WorldTerrain({ workerCount: 1 }, memoryStorage)
    const mesh = triangleSource('owned-source')
    expect(terrain.replaceSectionMesh({ x: 0, z: 0 }, mesh)).toBe(1)
    expect(terrain.partition.get({ x: 0, z: 0 })?.source.procedural).toBe(false)

    const firstRead = terrain.getSectionMesh({ x: 0, z: 0 })!
    firstRead.positions[0] = 99
    expect(terrain.getSectionMesh({ x: 0, z: 0 })!.positions[0]).toBe(10)

    expect(terrain.restoreProceduralSection({ x: 0, z: 0 })).toBe(2)
    expect(terrain.getSectionMesh({ x: 0, z: 0 })).toBeUndefined()
    terrain.dispose()
  })

  it('enforces the editable source memory budget before taking ownership', () => {
    const terrain = new WorldTerrain(
      { workerCount: 1, maxEditableMeshBytes: 8 },
      memoryStorage,
    )
    expect(() =>
      terrain.replaceSectionMesh({ x: 0, z: 0 }, triangleSource('too-large')),
    ).toThrow(/budget exceeded/)
    expect(terrain.partition.get({ x: 0, z: 0 })).toBeUndefined()
    terrain.dispose()
  })

  it('places deterministic granite objects and snapshots their exact topology as CSG', async () => {
    const terrain = new WorldTerrain({ workerCount: 1 }, memoryStorage)
    const recipe = graniteMassingPreset('tor', 908, 3)
    const rockId = terrain.addGraniteRock(recipe, { x: 12, y: 30, z: -8 })
    const rock = terrain.rocks.get(rockId)!

    expect(terrain.rocks.count).toBe(1)
    expect(rock.parameters).toEqual(recipe)
    const modifierId = await terrain.applyGraniteRockAsCsg(rockId, 'subtract')
    const modifier = terrain.modifiers.get(modifierId)
    expect(modifier?.type).toBe('boolean-volume')
    if (modifier?.type !== 'boolean-volume') throw new Error('Missing rock CSG modifier')
    expect(modifier.operation).toBe('subtract')
    expect(modifier.volumes[0]?.kind).toBe('mesh')
    if (modifier.volumes[0]?.kind !== 'mesh') throw new Error('Missing mesh cutter')
    const snapshot = [...modifier.volumes[0].positions]
    const lowest = snapshot.filter((_, index) => index % 3 === 1)
      .reduce((minimum, value) => Math.min(minimum, value), Infinity)
    expect(lowest).toBeLessThan(30)
    expect(lowest).toBeGreaterThan(28)
    expect(terrain.rocks.get(rockId)?.visible).toBe(false)

    terrain.updateGraniteRockParameters(rockId, {
      ...recipe,
      seed: recipe.seed + 1,
      detailStrength: 1,
    })
    expect(modifier.volumes[0].positions).toEqual(snapshot)
    expect(terrain.removeGraniteRock(rockId)).toBe(true)
    expect(terrain.rocks.count).toBe(0)
    terrain.dispose()
  })
})

function triangleSource(sourceId: string): EditableMesh {
  return new EditableMesh(
    new Float32Array([10, 0, 10, 20, 0, 10, 10, 0, 20]),
    new Uint32Array([0, 2, 1]),
    { sourceId },
  )
}

function fakeRenderer(
  previewBrush: TerrainRenderBackend['previewBrush'],
  previewWeightPaint: TerrainRenderBackend['previewWeightPaint'] = () => {},
): TerrainRenderBackend {
  return {
    upload: () => 0,
    has: () => false,
    setLod() {},
    setVisible() {},
    setSectionState() {},
    setOverlay() {},
    setRenderMode() {},
    setMaterialSettings() {},
    previewBrush,
    previewWeightPaint,
    raycast: () => undefined,
    flushDeferredDisposals() {},
    evict() {},
    stats: () => ({
      gpuBytes: 0,
      residentSections: 0,
      visibleSections: 0,
      triangles: 0,
      trianglesByLod: [0, 0, 0, 0, 0],
    }),
    dispose() {},
  }
}
