import { describe, expect, it } from 'vitest'
import { TreeRandom, vec3 } from '../math'
import { sampledAxis } from './axis'

describe('sampled growth axes', () => {
  it('eases an attached axis from its parent tangent into its authored bearing', () => {
    const samples = sampledAxis(
      vec3(0, 0, 0),
      vec3(1, 0, 0),
      10,
      1,
      0.1,
      new TreeRandom(12),
      {
        samples: 21,
        crook: 0,
        sag: 0,
        rise: 0,
        midSag: 0,
        startTangent: vec3(0, 1, 0),
        startTangentStrength: 0.82,
      },
    )

    const first = samples[0]!.position
    const second = samples[1]!.position
    const beforeLast = samples.at(-2)!.position
    const last = samples.at(-1)!.position
    const firstLength = Math.hypot(
      second.x - first.x,
      second.y - first.y,
      second.z - first.z,
    )
    const lastLength = Math.hypot(
      last.x - beforeLast.x,
      last.y - beforeLast.y,
      last.z - beforeLast.z,
    )

    expect((second.y - first.y) / firstLength).toBeGreaterThan(0.98)
    expect((last.x - beforeLast.x) / lastLength).toBeGreaterThan(0.98)
    expect(last.x).toBeCloseTo(10, 8)
    expect(last.y).toBeCloseTo(0, 8)
    expect(last.z).toBeCloseTo(0, 8)
  })
})
