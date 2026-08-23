import { describe, expect, it } from 'vitest'
import {
  hasNearbyBrushSample,
  nearbyBrushSampleIndices,
  supportsIndexedBrushEvaluation,
} from './BrushSampleIndex'
import { createBrushStroke, createWeightPaintStroke } from '../modifiers/factories'

describe('brush sample spatial index', () => {
  it('returns the exact candidate superset in authored order', () => {
    const stroke = createWeightPaintStroke({
      point: { x: -40, y: 2, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      channel: 'channel0',
      mode: 'add',
      radius: 8,
      strength: 1,
      falloff: 0.5,
    })
    stroke.points.length = 0
    for (let index = 0; index < 30; index += 1) {
      stroke.points.push({
        x: index * 4 - 40,
        y: index % 3,
        z: index % 2 === 0 ? 1 : -1,
        normal: { x: 0, y: 1, z: 0 },
        weight: 1,
      })
    }
    const point = { x: 4, y: 1, z: 0 }
    const candidates = [...nearbyBrushSampleIndices(stroke, point)]
    const exact = stroke.points.flatMap((sample, index) =>
      Math.hypot(point.x - sample.x, point.y - sample.y, point.z - sample.z) < stroke.radius
        ? [index]
        : [],
    )
    expect(candidates).toEqual([...candidates].sort((a, b) => a - b))
    expect(candidates).toEqual(expect.arrayContaining(exact))
    expect(candidates.length).toBeLessThan(stroke.points.length)
  })

  it('rebuilds lazily when a live stroke appends samples', () => {
    const stroke = createBrushStroke({
      point: { x: 0, y: 0, z: 0 },
      domain: 'heightfield',
      mode: 'raise',
      radius: 4,
      strength: 1,
      falloff: 0.5,
    })
    expect(nearbyBrushSampleIndices(stroke, { x: 40, y: 0, z: 0 })).toEqual([])

    stroke.points.push({
      x: 40,
      y: 0,
      z: 0,
      normal: { x: 0, y: 1, z: 0 },
      weight: 1,
    })
    expect(nearbyBrushSampleIndices(stroke, { x: 40, y: 0, z: 0 })).toEqual([1])
  })

  it('uses two-dimensional distance for heightfield feature locks', () => {
    const stroke = createBrushStroke({
      point: { x: 5, y: 100, z: 5 },
      mode: 'raise',
      domain: 'heightfield',
      radius: 4,
      strength: 1,
      falloff: 0.5,
    })
    expect(hasNearbyBrushSample(stroke, { x: 6, y: -100, z: 6 }, 4)).toBe(true)
  })

  it('falls back for brushes that can move a point between sample buckets', () => {
    const safe = createBrushStroke({
      point: { x: 0, y: 0, z: 0 },
      mode: 'raise',
      domain: 'heightfield',
      radius: 4,
      strength: 1,
      falloff: 0.5,
    })
    const lateral = createBrushStroke({
      point: { x: 0, y: 0, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
      mode: 'raise',
      domain: 'mesh',
      radius: 4,
      strength: 1,
      falloff: 0.5,
    })
    expect(supportsIndexedBrushEvaluation(safe)).toBe(true)
    expect(supportsIndexedBrushEvaluation(lateral)).toBe(false)
  })
})
