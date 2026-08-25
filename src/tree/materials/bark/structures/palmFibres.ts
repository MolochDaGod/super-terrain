import { clamp01, tiledFbm, tiledValueNoise } from '../../proceduralNoise'

export interface PalmFibreSample {
  /** Raised vascular-bundle strands at millimetre/centimetre scale. */
  relief: number
  /** Dry fibre colour variation, deliberately sharper than broad bark grain. */
  tone: number
}

/**
 * Dense lignified fibre bundles exposed between old palm leaf scars.
 *
 * Every frequency is integral in both axes, so the field tiles without a seam.
 * The fibres predominantly follow the stipe but wander, split and cross rather
 * than becoming the low-frequency vertical blur produced by stretched fBm.
 */
export function samplePalmFibres(u: number, v: number, seed: number): PalmFibreSample {
  const warp = (tiledValueNoise(u * 6, v * 18, seed + 503, 6, 18) - 0.5) * 2.7
  const meander = Math.sin(Math.PI * 2 * (v * 5 + seed * 0.000013)) * 0.32
  const strand = 0.5 + 0.5 * Math.cos(
    Math.PI * 2 * (u * 43 + v * 1.7 + warp + meander),
  )
  const split = 0.5 + 0.5 * Math.cos(
    Math.PI * 2 * (u * 27 - v * 6 + warp * 0.28 + 0.27),
  )
  const hair = Math.pow(strand, 5)
  const crossing = Math.pow(split, 7)
  const bundle = tiledFbm(u * 18, v * 54, seed + 541, 3, 18, 54)
  const clumps = tiledFbm(u * 7, v * 28, seed + 577, 3, 7, 28)
  return {
    relief: clamp01(0.12 + hair * clumps * 0.32 + crossing * 0.1 + bundle * 0.3),
    tone: clamp01(0.18 + hair * clumps * 0.2 + crossing * 0.08 + bundle * 0.4),
  }
}
