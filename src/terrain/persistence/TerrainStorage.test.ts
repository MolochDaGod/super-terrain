import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
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
        scale: 1.2,
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
        scale: 1,
      },
    }]
    await storage.save('alpha', modifiers, rocks)
    expect(await storage.load('alpha')).toEqual(modifiers)
    expect(await storage.loadRocks('alpha')).toEqual(rocks)
    await storage.clear('alpha')
    expect(await storage.load('alpha')).toBeUndefined()
    expect(await storage.loadRocks('alpha')).toBeUndefined()
  })
})
