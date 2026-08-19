import { describe, expect, it } from 'vitest'
import type { SectionId } from '../core/types'
import type { StreamCandidate } from '../streaming/TerrainStreamer'
import { HorizonProxyMask } from './HorizonProxyMask'

function candidate(
  x: number,
  z: number,
  visible = true,
): StreamCandidate {
  return {
    id: `${x}:${z}`,
    key: { x, z },
    priority: 0,
    distance: 0,
    visible,
    prefetch: !visible,
  }
}

describe('HorizonProxyMask', () => {
  it('marks only visible sections that are actually GPU resident', () => {
    const mask = new HorizonProxyMask(512, 128)
    const residents = new Set<SectionId>(['-2:-2', '0:0', '1:1'])

    expect(mask.update(
      [candidate(-2, -2), candidate(-1, -2), candidate(1, 1, false)],
      (id) => residents.has(id),
    )).toBe(true)

    expect(mask.width).toBe(4)
    expect(mask.height).toBe(4)
    expect(mask.data[0]).toBe(255)
    expect(mask.data[1]).toBe(0)
    expect(mask.data[15]).toBe(0)
    expect(mask.revision).toBe(1)
  })

  it('updates edge-for-edge and does not revise unchanged data', () => {
    const mask = new HorizonProxyMask(512, 128)
    const first = [candidate(-2, -2)]
    const second = [candidate(0, 0)]

    mask.update(first, () => true)
    expect(mask.update(first, () => true)).toBe(false)
    expect(mask.revision).toBe(1)

    expect(mask.update(second, () => true)).toBe(true)
    expect(mask.data[0]).toBe(0)
    expect(mask.data[10]).toBe(255)
    expect(mask.revision).toBe(2)

    expect(mask.clear()).toBe(true)
    expect(mask.data[10]).toBe(0)
    expect(mask.revision).toBe(3)
    expect(mask.clear()).toBe(false)
  })
})
