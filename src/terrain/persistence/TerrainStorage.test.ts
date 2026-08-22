import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import type { CompiledSection } from '../core/types'
import { createRemeshModifier } from '../modifiers/factories'
import { IndexedDbTerrainStorage } from './TerrainStorage'
import { deserializeWorld, serializeWorld } from './serialization'
import { graniteMassingPreset, type GraniteRock } from '../rocks/types'

describe('terrain persistence', () => {
  it('round-trips versioned modifier data', () => {
    const modifiers = [
      createRemeshModifier({
        center: { x: 4, y: 2, z: -9 },
        radius: 20,
        targetEdgeLength: 2,
      }),
    ]
    const rocks: GraniteRock[] = [{
      id: 'rock-unit',
      name: 'Unit granite',
      visible: true,
      parameters: graniteMassingPreset('bench', 42, 3),
      transform: {
        position: { x: 3, y: 8, z: -2 },
        rotation: { x: 0, y: 0.4, z: 0 },
        scale: { x: 1.2, y: 1.2, z: 1.2 },
      },
    }]
    const restored = deserializeWorld(serializeWorld('unit', modifiers, rocks))
    expect(restored.version).toBe(6)
    expect(restored.modifiers).toEqual(modifiers)
    expect(restored.rocks).toEqual(rocks)
  })

  it('stores independent worlds in IndexedDB', async () => {
    const storage = new IndexedDbTerrainStorage(`terrain-test-${crypto.randomUUID()}`)
    const modifiers = [
      createRemeshModifier({
        center: { x: 0, y: 0, z: 0 },
        radius: 8,
        targetEdgeLength: 1,
      }),
    ]
    const rocks: GraniteRock[] = [{
      id: 'rock-alpha',
      name: 'Alpha granite',
      visible: true,
      parameters: graniteMassingPreset('tor', 17, 2),
      transform: {
        position: { x: 1, y: 4, z: 2 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]
    await storage.save('alpha', modifiers, rocks)
    expect(await storage.load('alpha')).toEqual(modifiers)
    expect(await storage.loadRocks('alpha')).toEqual(rocks)
    await storage.clear('alpha')
    expect(await storage.load('alpha')).toBeUndefined()
    expect(await storage.loadRocks('alpha')).toBeUndefined()
  })

  it('stores typed compiled meshes separately and clears them with the world', async () => {
    const storage = new IndexedDbTerrainStorage(`terrain-cache-${crypto.randomUUID()}`)
    const compiled = compiledFixture()
    await storage.saveCompiledSections('alpha', [{
      sectionId: '2:-1',
      signature: 'exact-input-signature',
      compiled,
    }])

    expect(await storage.loadCompiledSectionKeys('alpha')).toEqual(['2:-1'])
    const [restored] = await storage.loadCompiledSections('alpha', ['2:-1'])
    expect(restored?.signature).toBe('exact-input-signature')
    expect(restored?.compiled.lods[0]?.positions).toBeInstanceOf(Float32Array)
    expect([...restored!.compiled.lods[0]!.positions]).toEqual([0, 1, 2])

    await storage.clear('alpha')
    expect(await storage.loadCompiledSectionKeys('alpha')).toEqual([])
  })
})

function compiledFixture(): CompiledSection {
  const emptyFields = Array.from(
    { length: 5 },
    () => new Uint16Array(),
  ) as unknown as NonNullable<
    CompiledSection['lods'][number]['surfaceFields']
  >
  return {
    key: { x: 2, z: -1 },
    sourceRevision: 0,
    bounds: {
      min: { x: 256, y: 0, z: -128 },
      max: { x: 384, y: 2, z: 0 },
    },
    lods: [{
      level: 2,
      geometricError: 4,
      positions: new Float32Array([0, 1, 2]),
      normals: new Float32Array([0, 1, 0]),
      colors: new Float32Array([0.2, 0.4, 0.3]),
      surfaceFields: emptyFields,
      paintWeights: new Uint16Array(4),
      indices: new Uint32Array([0, 0, 0]),
      triangleCount: 1,
      gpuBytes: 52,
    }],
    metadata: {
      compileMs: 12,
      vertexCount: 1,
      triangleCount: 1,
      density: 1,
      hasArbitraryTopology: false,
      validationWarnings: 0,
    },
    cpuBytes: 52,
    gpuBytes: 52,
  }
}
