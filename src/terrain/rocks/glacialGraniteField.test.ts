import { describe, expect, it } from 'vitest'
import { createGlacialGraniteField } from './glacialGraniteField'
import { graniteMassingOfSeed } from './types'

describe('scifi-kit granite field compatibility', () => {
  it('keeps the source seed-to-formation mapping', () => {
    expect([1, 2, 3, 4, 5, 6].map(graniteMassingOfSeed)).toEqual([
      'erratic',
      'prow',
      'arch',
      'tor',
      'bench',
      'monolith',
    ])
  })

  it('matches source field samples across all six formations', () => {
    const samples = [
      [1, 0.2, 0.3, -0.1, 0, -0.10732507405027192],
      [2, -0.7, 0.4, 0.6, 0.12, 0.30439247121938823],
      [3, 0, 0, 0, 0.3, 0.2523948588570436],
      [4, 0.95, -0.2, 0.4, 0, 0.22403797725822625],
      [5, 0.1, -0.35, 0.78, 0.12, 0.23233555092205876],
      [6, -0.4, 0.6, -0.2, 0.3, 0.23084083996748139],
    ] as const

    for (const [seed, x, y, z, minimumWavelength, expected] of samples) {
      expect(
        createGlacialGraniteField(seed).sdf(
          x,
          y,
          z,
          seed,
          minimumWavelength,
        ),
      ).toBeCloseTo(expected, 14)
    }
  })
})
