import { describe, expect, it } from 'vitest'
import {
  drawableGraniteLodWeights,
  projectedGraniteErrorPixels,
  settleGraniteLodWeights,
  targetGraniteLodWeights,
} from './graniteRockLod'

describe('granite screen-space LOD', () => {
  it('keeps LOD0 while coarser geometry error is visible', () => {
    expect(targetGraniteLodWeights(16, 12)).toEqual([1, 0, 0])
  })

  it('cross-fades through LOD1 before LOD2', () => {
    expect(targetGraniteLodWeights(5, 10)).toEqual([0, 1, 0])
    expect(targetGraniteLodWeights(2, 3)).toEqual([0, 0, 1])
  })

  it('projects errors and settles normalized weights continuously', () => {
    const near = projectedGraniteErrorPixels(0.1, 10, 40, 1080)
    const far = projectedGraniteErrorPixels(0.1, 20, 40, 1080)
    expect(near).toBeCloseTo(far * 2, 10)
    const next = settleGraniteLodWeights([1, 0, 0], [0, 0, 1], 1 / 60)
    expect(next[0]).toBeGreaterThan(0)
    expect(next[2]).toBeGreaterThan(0)
    expect(next[0] + next[1] + next[2]).toBeCloseTo(1, 10)
  })

  it('closes the dither interval when a layer becomes negligible', () => {
    const drawable = drawableGraniteLodWeights([0.001, 0.499, 0.5])
    expect(drawable[0]).toBe(0)
    expect(drawable[0] + drawable[1] + drawable[2]).toBeCloseTo(1, 10)
  })
})
