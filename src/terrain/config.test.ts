import { describe, expect, it } from 'vitest'
import { recommendedTerrainWorkerCount } from './config'

describe('recommendedTerrainWorkerCount', () => {
  it.each([
    [1, 2],
    [4, 2],
    [8, 5],
    [12, 6],
    [24, 6],
  ])('uses a bounded background share of %i logical cores', (cores, workers) => {
    expect(recommendedTerrainWorkerCount(cores)).toBe(workers)
  })

  it('handles invalid hardware-concurrency values', () => {
    expect(recommendedTerrainWorkerCount(Number.NaN)).toBe(2)
  })
})
