import {
  cascadeForPoint,
  cascadeSize,
  totalProbes,
  volumeIndex,
  worldToCell,
  type ProbeRef,
} from './cascades.ts'
import type { SH2 } from './types.ts'
import { addSH, copySH, emptySH, evaluateIrradiance as evalSH, mixSH, scaleSH } from './sphericalHarmonics.ts'
import {
  DEFAULT_CASCADE,
  type CascadeConfig,
  type Vec3,
} from './types.ts'

export { evalSH as evaluateIrradiance }

export interface VolumeSample {
  sh: SH2
  cascade: number
}

/**
 * World-space cascaded irradiance volumes. Each cell stores 2-band RGB SH of
 * incoming radiance. Sampling is trilinear within a cascade; the finest
 * cascade that still contains the point is chosen (Sousa uses the same
 * nested-volume idea).
 */
export class IrradianceVolumeField {
  readonly config: CascadeConfig
  readonly current: SH2[]
  readonly previous: SH2[]

  constructor(config: CascadeConfig = DEFAULT_CASCADE) {
    this.config = config
    const count = totalProbes(config)
    this.current = Array.from({ length: count }, () => emptySH())
    this.previous = Array.from({ length: count }, () => emptySH())
  }

  get(index: number): SH2 {
    return this.current[index] ?? emptySH()
  }

  getPrevious(index: number): SH2 {
    return this.previous[index] ?? emptySH()
  }

  set(index: number, sh: SH2): void {
    this.current[index] = copySH(sh)
  }

  /**
   * Write a newly traced probe. `previousFrameBlend` is Sousa's "add previous
   * frame" temporal mix — not a second trace, just feedback of last frame's
   * irradiance so extra bounces accumulate across frames.
   */
  updateProbe(probe: ProbeRef, traced: SH2, previousFrameBlend = 0.35): void {
    const prev = this.previous[probe.index] ?? emptySH()
    this.current[probe.index] = mixSH(traced, prev, previousFrameBlend)
  }

  /** Swap current into previous at the end of a frame (whole-field snapshot). */
  advanceFrame(): void {
    for (let i = 0; i < this.current.length; i += 1) {
      this.previous[i] = copySH(this.current[i] ?? emptySH())
    }
  }

  sample(world: Vec3, camera: Vec3): SH2 | null {
    const cascade = cascadeForPoint(world, camera, this.config)
    const half = cascadeSize(cascade, this.config) * 0.5
    if (
      Math.abs(world[0] - camera[0]) > half ||
      Math.abs(world[1] - camera[1]) > half ||
      Math.abs(world[2] - camera[2]) > half
    ) {
      if (cascade >= this.config.cascadeCount - 1) return null
    }
    return this.sampleCascade(world, camera, cascade)
  }

  sampleCascade(world: Vec3, camera: Vec3, cascade: number): SH2 {
    const res = this.config.resolution
    const { ix, iy, iz, fx, fy, fz } = worldToCell(world, cascade, camera, this.config)
    const sh = emptySH()
    let weight = 0
    for (let dz = 0; dz <= 1; dz += 1) {
      for (let dy = 0; dy <= 1; dy += 1) {
        for (let dx = 0; dx <= 1; dx += 1) {
          const cx = ix + dx
          const cy = iy + dy
          const cz = iz + dz
          if (cx < 0 || cy < 0 || cz < 0 || cx >= res || cy >= res || cz >= res) continue
          const w =
            (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy) * (dz === 0 ? 1 - fz : fz)
          if (w <= 0) continue
          const index = volumeIndex(cascade, cx, cy, cz, this.config)
          const cell = this.current[index]
          if (!cell) continue
          sh.l0[0] += cell.l0[0] * w
          sh.l0[1] += cell.l0[1] * w
          sh.l0[2] += cell.l0[2] * w
          sh.lx[0] += cell.lx[0] * w
          sh.lx[1] += cell.lx[1] * w
          sh.lx[2] += cell.lx[2] * w
          sh.ly[0] += cell.ly[0] * w
          sh.ly[1] += cell.ly[1] * w
          sh.ly[2] += cell.ly[2] * w
          sh.lz[0] += cell.lz[0] * w
          sh.lz[1] += cell.lz[1] * w
          sh.lz[2] += cell.lz[2] * w
          weight += w
        }
      }
    }
    if (weight < 1e-6) return emptySH()
    if (weight < 0.999) return scaleSH(sh, 1 / weight)
    return sh
  }

  clear(): void {
    for (let i = 0; i < this.current.length; i += 1) {
      this.current[i] = emptySH()
      this.previous[i] = emptySH()
    }
  }
}

export function addScaledSH(target: SH2, source: SH2, scale: number): void {
  const scaled = scaleSH(source, scale)
  const mixed = addSH(target, scaled)
  target.l0 = mixed.l0
  target.lx = mixed.lx
  target.ly = mixed.ly
  target.lz = mixed.lz
}
