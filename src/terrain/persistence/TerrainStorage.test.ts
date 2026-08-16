import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createRemeshModifier } from '../modifiers/factories'
import { IndexedDbTerrainStorage } from './TerrainStorage'
import { deserializeWorld, serializeWorld } from './serialization'

describe('terrain persistence', () => {
  it('round-trips versioned modifier data', () => {
    const modifiers = [
      createRemeshModifier({
        center: { x: 4, y: 2, z: -9 },
        radius: 20,
        targetEdgeLength: 2,
      }),
    ]
    const restored = deserializeWorld(serializeWorld('unit', modifiers))
    expect(restored.version).toBe(4)
    expect(restored.modifiers).toEqual(modifiers)
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
    await storage.save('alpha', modifiers)
    expect(await storage.load('alpha')).toEqual(modifiers)
    await storage.clear('alpha')
    expect(await storage.load('alpha')).toBeUndefined()
  })
})
