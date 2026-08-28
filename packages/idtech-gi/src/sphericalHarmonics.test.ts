import { describe, expect, it } from 'vitest'
import { PI, fibonacciSphere } from './math.ts'
import {
  decodeRadiance,
  encodeRadiance,
  evaluateIrradiance,
  SH_Y00,
} from './sphericalHarmonics.ts'
import { emptySH } from './sphericalHarmonics.ts'
import type { Rgb, SH2 } from './types.ts'

function accumulateSphere(radiance: Rgb, samples: number): SH2 {
  const solid = (4 * PI) / samples
  const sh = emptySH()
  for (let i = 0; i < samples; i += 1) {
    const dir = fibonacciSphere(samples, i)
    const encoded = encodeRadiance(dir, radiance, solid)
    sh.l0[0] += encoded.l0[0]
    sh.l0[1] += encoded.l0[1]
    sh.l0[2] += encoded.l0[2]
    sh.lx[0] += encoded.lx[0]
    sh.lx[1] += encoded.lx[1]
    sh.lx[2] += encoded.lx[2]
    sh.ly[0] += encoded.ly[0]
    sh.ly[1] += encoded.ly[1]
    sh.ly[2] += encoded.ly[2]
    sh.lz[0] += encoded.lz[0]
    sh.lz[1] += encoded.lz[1]
    sh.lz[2] += encoded.lz[2]
  }
  return sh
}

describe('2-band SH encode/decode of known irradiance', () => {
  it('projects uniform white radiance to L00 ≈ 1 and irradiance ≈ π', () => {
    const sh = accumulateSphere([1, 1, 1], 256)
    // ∫ Y00 dω = √(4π), so L00 = 1 * Y00 * 4π = √(4π) ≈ 3.5449, reconstruction
    // of radiance is Y00 * L00 ≈ 1.
    const reconstructed = decodeRadiance(sh, [0, 1, 0])
    expect(reconstructed[0]).toBeCloseTo(1, 1)
    expect(reconstructed[1]).toBeCloseTo(1, 1)
    expect(reconstructed[2]).toBeCloseTo(1, 1)
    expect(sh.l0[0]).toBeCloseTo(SH_Y00 * 4 * PI, 1)

    const up = evaluateIrradiance(sh, [0, 1, 0])
    const down = evaluateIrradiance(sh, [0, -1, 0])
    const side = evaluateIrradiance(sh, [1, 0, 0])
    // Uniform incoming radiance L=1 → Lambertian irradiance π.
    expect(up[0]).toBeCloseTo(PI, 1)
    expect(down[0]).toBeCloseTo(PI, 1)
    expect(side[0]).toBeCloseTo(PI, 1)
  })

  it('encodes a directional sample and recovers a brighter side along that axis', () => {
    const dir: [number, number, number] = [0, 1, 0]
    const sh = encodeRadiance(dir, [2, 0.1, 0.1], 1)
    const along = evaluateIrradiance(sh, [0, 1, 0])
    const against = evaluateIrradiance(sh, [0, -1, 0])
    expect(along[0]).toBeGreaterThan(against[0])
    expect(along[0]).toBeGreaterThan(along[1])
    const decoded = decodeRadiance(sh, dir)
    expect(decoded[0]).toBeGreaterThan(decoded[1])
  })
})
