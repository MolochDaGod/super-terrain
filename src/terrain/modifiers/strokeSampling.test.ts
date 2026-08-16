import { describe, expect, it } from 'vitest'
import { sampleStrokeSegment } from './strokeSampling'

describe('stroke sampling', () => {
  it('fills a fast pointer segment at stable spatial intervals', () => {
    const samples = sampleStrokeSegment(
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      2,
    )
    expect(samples).toHaveLength(5)
    expect(samples.map((sample) => sample.x)).toEqual([2, 4, 6, 8, 10])
    expect(Math.hypot(
      samples[2].normal.x,
      samples[2].normal.y,
      samples[2].normal.z,
    )).toBeCloseTo(1, 8)
  })

  it('does not emit another dab before the spacing threshold', () => {
    expect(
      sampleStrokeSegment(
        { x: 0, y: 0, z: 0 },
        { x: 0.5, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
        1,
      ),
    ).toEqual([])
  })
})
