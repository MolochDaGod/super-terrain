import { describe, expect, it } from 'vitest'
import { DEFAULT_TERRAIN_CONFIG } from '../config'
import {
  TerrainStreamer,
  requiredViewRadiusSections,
  streamingPriority,
} from './TerrainStreamer'

describe('terrain streaming', () => {
  it('prioritizes edit focus, visibility and forward motion', () => {
    expect(streamingPriority(3, 1, false, true)).toBeGreaterThan(
      streamingPriority(3, -1, false, true),
    )
    expect(streamingPriority(5, 0, true, false)).toBeGreaterThan(
      streamingPriority(0, 0, false, true),
    )
    expect(streamingPriority(5, 0, false, true, 1)).toBeGreaterThan(
      streamingPriority(5, 0, false, true, -1),
    )
  })

  it('retains recently departed sections and later evicts by LRU age', () => {
    const streamer = new TerrainStreamer({
      ...DEFAULT_TERRAIN_CONFIG,
      renderRadiusSections: 2,
      prefetchSections: 0,
      sectionRetentionMs: 1_000,
    })
    streamer.update({ x: 0, y: 20, z: 0 }, 1, undefined, 0)
    streamer.touch({ x: 0, z: 0 }, 'GPU_RESIDENT', 100, 100, 0)
    streamer.update({ x: 2_000, y: 20, z: 2_000 }, 1, undefined, 100)
    expect(streamer.collectEvictions(500)).not.toContain('0:0')
    expect(streamer.collectEvictions(1_500)).toContain('0:0')
  })

  it('reports what left the working set and reuses its candidate records', () => {
    const streamer = new TerrainStreamer({
      ...DEFAULT_TERRAIN_CONFIG,
      worldSize: 4_096,
      renderRadiusSections: 2,
      maxRenderRadiusSections: 2,
      prefetchSections: 0,
    })
    const first = streamer.update({ x: 0, y: 20, z: 0 }, 1, undefined, 0)
    const centre = first.find((candidate) => candidate.id === '0:0')
    expect(centre).toBeDefined()
    expect(streamer.candidatesById.get('0:0')).toBe(centre)

    const second = streamer.update({ x: 40, y: 20, z: 0 }, 1, undefined, 16)
    // Still in range, so the record is the same object rewritten in place
    // rather than a replacement allocated for the frame.
    expect(second.find((candidate) => candidate.id === '0:0')).toBe(centre)
    expect(streamer.departed).toHaveLength(0)

    streamer.update({ x: 3_000, y: 20, z: 3_000 }, 1, undefined, 32)
    expect(streamer.departed).toContain('0:0')
    expect(streamer.hidden).toContain('0:0')
    expect(streamer.candidatesById.has('0:0')).toBe(false)
  })

  it('reports the smoothed speed the detail floor is chosen from', () => {
    const streamer = new TerrainStreamer(DEFAULT_TERRAIN_CONFIG)
    streamer.update({ x: 0, y: 20, z: 0 }, 1, undefined, 0)
    expect(streamer.horizontalSpeed).toBe(0)
    for (let step = 1; step <= 30; step += 1) {
      streamer.update({ x: step * 2, y: 20, z: 0 }, 1, undefined, step * 16)
    }
    // 2 m per 16 ms is 125 m/s; the smoothing only has to have caught up enough
    // to be recognisably fast.
    expect(streamer.horizontalSpeed).toBeGreaterThan(90)
  })

  it('centers residency on the viewed terrain instead of the orbiting camera', () => {
    const streamer = new TerrainStreamer({
      ...DEFAULT_TERRAIN_CONFIG,
      renderRadiusSections: 2,
      maxRenderRadiusSections: 10,
      prefetchSections: 0,
    })
    const candidates = streamer.update(
      { x: 1_600, y: 900, z: 1_600 },
      1,
      undefined,
      0,
      {
        focus: { x: 0, y: 20, z: 0 },
        verticalFovRadians: Math.PI / 4,
        aspect: 16 / 9,
      },
    )
    expect(candidates.find((candidate) => candidate.id === '0:0')?.visible).toBe(true)
    expect(candidates.some((candidate) => candidate.id === '12:12')).toBe(false)
  })

  it('does not contract visible terrain when frame quality changes', () => {
    const streamer = new TerrainStreamer({
      ...DEFAULT_TERRAIN_CONFIG,
      renderRadiusSections: 3,
      maxRenderRadiusSections: 3,
      prefetchSections: 0,
    })
    const full = streamer
      .update({ x: 0, y: 30, z: 0 }, 1, undefined, 0)
      .filter((candidate) => candidate.visible)
      .map((candidate) => candidate.id)
      .sort()
    const pressured = streamer
      .update({ x: 0, y: 30, z: 0 }, 0.48, undefined, 16)
      .filter((candidate) => candidate.visible)
      .map((candidate) => candidate.id)
      .sort()
    expect(pressured).toEqual(full)
  })

  it('expands the working set with the projected viewport footprint', () => {
    const radius = requiredViewRadiusSections(
      {
        sectionSize: 128,
        renderRadiusSections: 4,
        maxRenderRadiusSections: 24,
      },
      { x: 0, y: 1_400, z: 1_400 },
      {
        focus: { x: 0, y: 20, z: 0 },
        verticalFovRadians: Math.PI / 3,
        aspect: 16 / 9,
      },
    )
    expect(radius).toBeGreaterThan(12)
    expect(radius).toBeLessThanOrEqual(24)
  })
})
