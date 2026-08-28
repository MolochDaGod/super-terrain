import { PI } from './math.ts'
import { addRgb, scaleRgb, zeroSH, type Rgb, type SH2, type Vec3 } from './types.ts'

/** Y00 */
export const SH_Y00 = 0.28209479177387814
/** Y1m magnitude (√(3/4π)) */
export const SH_Y1 = 0.4886025119029199
/** Cosine-lobe convolution of L0 (Ramamoorthi 2001). */
export const SH_A0 = PI
/** Cosine-lobe convolution of L1. */
export const SH_A1 = (2 * PI) / 3

export function copySH(sh: SH2): SH2 {
  return {
    l0: [sh.l0[0], sh.l0[1], sh.l0[2]],
    lx: [sh.lx[0], sh.lx[1], sh.lx[2]],
    ly: [sh.ly[0], sh.ly[1], sh.ly[2]],
    lz: [sh.lz[0], sh.lz[1], sh.lz[2]],
  }
}

export function addSH(a: SH2, b: SH2): SH2 {
  return {
    l0: addRgb(a.l0, b.l0),
    lx: addRgb(a.lx, b.lx),
    ly: addRgb(a.ly, b.ly),
    lz: addRgb(a.lz, b.lz),
  }
}

export function scaleSH(sh: SH2, s: number): SH2 {
  return {
    l0: scaleRgb(sh.l0, s),
    lx: scaleRgb(sh.lx, s),
    ly: scaleRgb(sh.ly, s),
    lz: scaleRgb(sh.lz, s),
  }
}

/**
 * Project a directional radiance sample onto 2-band SH.
 * `omega` is the incoming direction (from the probe toward the sample).
 * `solidAngle` is the measure of that sample (4π/N for a uniform sphere).
 */
export function encodeRadiance(omega: Vec3, radiance: Rgb, solidAngle: number): SH2 {
  const y00 = SH_Y00 * solidAngle
  const y1 = SH_Y1 * solidAngle
  return {
    l0: scaleRgb(radiance, y00),
    lx: scaleRgb(radiance, y1 * omega[0]),
    ly: scaleRgb(radiance, y1 * omega[1]),
    lz: scaleRgb(radiance, y1 * omega[2]),
  }
}

/** Reconstruct incoming radiance in direction `omega`. */
export function decodeRadiance(sh: SH2, omega: Vec3): Rgb {
  return [
    SH_Y00 * sh.l0[0] + SH_Y1 * (sh.lx[0] * omega[0] + sh.ly[0] * omega[1] + sh.lz[0] * omega[2]),
    SH_Y00 * sh.l0[1] + SH_Y1 * (sh.lx[1] * omega[0] + sh.ly[1] * omega[1] + sh.lz[1] * omega[2]),
    SH_Y00 * sh.l0[2] + SH_Y1 * (sh.lx[2] * omega[0] + sh.ly[2] * omega[1] + sh.lz[2] * omega[2]),
  ]
}

/**
 * Diffuse irradiance (Lambertian cosine lobe) along `normal`.
 * Volumes store *radiance* SH; this applies the Ramamoorthi convolution.
 */
export function evaluateIrradiance(sh: SH2, normal: Vec3): Rgb {
  const c0 = SH_A0 * SH_Y00
  const c1 = SH_A1 * SH_Y1
  return [
    Math.max(0, c0 * sh.l0[0] + c1 * (sh.lx[0] * normal[0] + sh.ly[0] * normal[1] + sh.lz[0] * normal[2])),
    Math.max(0, c0 * sh.l0[1] + c1 * (sh.lx[1] * normal[0] + sh.ly[1] * normal[1] + sh.lz[1] * normal[2])),
    Math.max(0, c0 * sh.l0[2] + c1 * (sh.lx[2] * normal[0] + sh.ly[2] * normal[1] + sh.lz[2] * normal[2])),
  ]
}

/** Final-gather pixels store already-convolved irradiance SH. Evaluate without A0/A1. */
export function evaluateStoredIrradiance(sh: SH2, normal: Vec3): Rgb {
  return [
    Math.max(0, SH_Y00 * sh.l0[0] + SH_Y1 * (sh.lx[0] * normal[0] + sh.ly[0] * normal[1] + sh.lz[0] * normal[2])),
    Math.max(0, SH_Y00 * sh.l0[1] + SH_Y1 * (sh.lx[1] * normal[0] + sh.ly[1] * normal[1] + sh.lz[1] * normal[2])),
    Math.max(0, SH_Y00 * sh.l0[2] + SH_Y1 * (sh.lx[2] * normal[0] + sh.ly[2] * normal[1] + sh.lz[2] * normal[2])),
  ]
}

/** Convert radiance SH into irradiance SH so a later eval is a cheap dot. */
export function convolveIrradiance(sh: SH2): SH2 {
  return {
    l0: scaleRgb(sh.l0, SH_A0),
    lx: scaleRgb(sh.lx, SH_A1),
    ly: scaleRgb(sh.ly, SH_A1),
    lz: scaleRgb(sh.lz, SH_A1),
  }
}

export function encodeIrradianceSample(omega: Vec3, irradiance: Rgb, weight: number): SH2 {
  return encodeRadiance(omega, irradiance, weight)
}

export function mixSH(a: SH2, b: SH2, t: number): SH2 {
  const u = 1 - t
  return addSH(scaleSH(a, u), scaleSH(b, t))
}

export function emptySH(): SH2 {
  return zeroSH()
}

export function shEnergy(sh: SH2): number {
  return sh.l0[0] + sh.l0[1] + sh.l0[2]
}
