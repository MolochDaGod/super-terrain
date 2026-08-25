import { describe, expect, it } from 'vitest'
import { sampleColumnarFissures } from './columnarFissures'

describe('columnar hardwood fissures', () => {
  it('wraps exactly across both texture seams', () => {
    for (const [u, v] of [[0.013, 0.07], [0.42, 0.51], [0.97, 0.94]]) {
      const sample = sampleColumnarFissures(u, v, 20, 7, 84721)
      for (const wrapped of [
        sampleColumnarFissures(u + 1, v, 20, 7, 84721),
        sampleColumnarFissures(u, v + 1, 20, 7, 84721),
      ]) {
        expect(wrapped.majorBorder).toBeCloseTo(sample.majorBorder, 12)
        expect(wrapped.majorStrength).toBeCloseTo(sample.majorStrength, 12)
        if (Number.isFinite(sample.crossBreakBorder)) {
          expect(wrapped.crossBreakBorder).toBeCloseTo(sample.crossBreakBorder, 12)
        } else {
          expect(wrapped.crossBreakBorder).toBe(sample.crossBreakBorder)
        }
        expect(wrapped.plateIdentity).toBe(sample.plateIdentity)
      }
    }
  })

  it('contains both retained longitudinal edges and suppressed transverse edges', () => {
    let closed = 0
    let open = 0
    const samples = 32 * 64
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const sample = sampleColumnarFissures(x / 32, y / 64, 20, 7, 84721)
        if (sample.majorStrength < 0.02) closed += 1
        if (sample.majorStrength > 0.9) open += 1
        expect(sample.crossBreakBorder).toBe(Number.POSITIVE_INFINITY)
      }
    }
    expect(closed).toBeGreaterThan(samples * 0.08)
    expect(open).toBeGreaterThan(samples * 0.08)
  })
})
