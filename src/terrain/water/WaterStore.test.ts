import { describe, expect, it } from 'vitest'
import { WaterStore } from './WaterStore'

describe('WaterStore', () => {
  it('starts dry', () => {
    const water = new WaterStore(1024)
    expect(water.hasWater).toBe(false)
    expect(water.bounds()).toBeUndefined()
    expect(water.sample(0, 0)).toBe(0)
  })

  it('floods under the brush and drains again', () => {
    const water = new WaterStore(1024)
    expect(water.paint({ x: 0, y: 0, z: 0 }, 64, 1, 'add')).toBe(true)
    expect(water.sample(0, 0)).toBeGreaterThan(0.5)
    // Well outside the brush, so the mask has a genuine edge rather than a
    // world-wide fill.
    expect(water.sample(300, 300)).toBe(0)

    expect(water.paint({ x: 0, y: 0, z: 0 }, 64, 1, 'remove')).toBe(true)
    expect(water.sample(0, 0)).toBe(0)
    expect(water.hasWater).toBe(false)
  })

  it('bumps the revision only when coverage actually changes', () => {
    const water = new WaterStore(1024)
    const before = water.getSnapshot().revision
    water.paint({ x: 0, y: 0, z: 0 }, 40, 1, 'add')
    const after = water.getSnapshot().revision
    expect(after).toBeGreaterThan(before)
    // Repeated strokes keep deepening the soft rim, so drive it to saturation
    // first; once there, flooding what is already flooded is not a change.
    while (water.paint({ x: 0, y: 0, z: 0 }, 40, 1, 'add')) continue
    const saturated = water.getSnapshot().revision
    expect(saturated).toBeGreaterThanOrEqual(after)
    water.paint({ x: 0, y: 0, z: 0 }, 40, 1, 'add')
    expect(water.getSnapshot().revision).toBe(saturated)
  })

  it('meshes only the painted region', () => {
    const water = new WaterStore(2048)
    water.paint({ x: 200, y: 0, z: -120 }, 50, 1, 'add')
    const bounds = water.bounds()
    expect(bounds).toBeDefined()
    expect(bounds!.min.x).toBeGreaterThan(100)
    expect(bounds!.max.x).toBeLessThan(300)
    expect(bounds!.min.z).toBeGreaterThan(-220)
    expect(bounds!.max.z).toBeLessThan(-20)
  })

  it('round-trips through serialization', () => {
    const water = new WaterStore(1024)
    water.paint({ x: 32, y: 0, z: 32 }, 48, 1, 'add')
    water.patch({ level: 61.5, turbidity: 0.8 })
    const payload = water.serialize()

    const restored = new WaterStore(1024)
    restored.restore({ state: payload.state, coverage: payload.coverage })
    expect(restored.getSnapshot().level).toBe(61.5)
    expect(restored.getSnapshot().turbidity).toBe(0.8)
    expect(restored.sample(32, 32)).toBeCloseTo(water.sample(32, 32), 2)
    expect(restored.hasWater).toBe(true)
  })
})
