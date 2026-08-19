import { describe, expect, it } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import {
  setQuaternionFromSpotlightDirection,
  spotlightDirectionFromQuaternion,
} from './spotlightTransform'

describe('spotlight transform orientation', () => {
  it('keeps the straight-down default orientation finite and stable', () => {
    const quaternion = setQuaternionFromSpotlightDirection(
      new Quaternion(),
      new Vector3(0, -1, 0),
    )
    const direction = spotlightDirectionFromQuaternion(
      quaternion,
      new Vector3(),
    )

    expect(direction.x).toBeCloseTo(0, 8)
    expect(direction.y).toBeCloseTo(-1, 8)
    expect(direction.z).toBeCloseTo(0, 8)
    expect(quaternion.toArray().every(Number.isFinite)).toBe(true)
  })

  it('changes continuously for a tiny single-axis direction edit', () => {
    const initial = setQuaternionFromSpotlightDirection(
      new Quaternion(),
      new Vector3(0, -1, 0),
    )
    const edited = setQuaternionFromSpotlightDirection(
      new Quaternion(),
      new Vector3(0.001, -1, 0),
    )

    expect(initial.angleTo(edited)).toBeLessThan(0.002)
  })

  it('round-trips an arbitrary spotlight direction', () => {
    const expected = new Vector3(0.35, -0.7, 0.22).normalize()
    const quaternion = setQuaternionFromSpotlightDirection(
      new Quaternion(),
      expected,
    )
    const actual = spotlightDirectionFromQuaternion(
      quaternion,
      new Vector3(),
    )

    expect(actual.distanceTo(expected)).toBeLessThan(1e-8)
  })
})
