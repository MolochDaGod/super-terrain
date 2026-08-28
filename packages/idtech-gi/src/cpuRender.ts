import { normalize3, sub3 } from './math.ts'
import type { SousaPipeline } from './pipeline.ts'
import type { Rgb, Vec3 } from './types.ts'
import type { VoxelGrid } from './voxelGrid.ts'

export interface CpuCamera {
  position: Vec3
  target: Vec3
  up?: Vec3
  fovY: number
  near?: number
}

export interface CpuFrame {
  width: number
  height: number
  rgba: Uint8Array
}

function cameraBasis(camera: CpuCamera): { origin: Vec3; right: Vec3; up: Vec3; forward: Vec3 } {
  const origin = camera.position
  const forward = normalize3(sub3(camera.target, origin))
  const worldUp = camera.up ?? [0, 1, 0]
  const right = normalize3([
    forward[1] * worldUp[2] - forward[2] * worldUp[1],
    forward[2] * worldUp[0] - forward[0] * worldUp[2],
    forward[0] * worldUp[1] - forward[1] * worldUp[0],
  ])
  const up: Vec3 = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ]
  return { origin, right, up, forward }
}

/**
 * Rasterise the voxel scene with the shipped Sousa pipeline: primary vis via
 * DDA, direct from `shadeHit`, indirect from irradiance volumes when `gi` is
 * on. Used by tests and by the capture harness as a CPU proof of bounce.
 */
export function renderCpuFrame(
  pipeline: SousaPipeline,
  voxel: VoxelGrid,
  camera: CpuCamera,
  width: number,
  height: number,
  gi: boolean,
): CpuFrame {
  const rgba = new Uint8Array(width * height * 4)
  const basis = cameraBasis(camera)
  const tanHalf = Math.tan((camera.fovY * Math.PI) / 360)
  const aspect = width / height
  const maxDist = voxel.size * 1.7

  for (let y = 0; y < height; y += 1) {
    const ny = (1 - (y + 0.5) / height) * 2 - 1
    for (let x = 0; x < width; x += 1) {
      const nx = ((x + 0.5) / width) * 2 - 1
      const dir = normalize3([
        basis.forward[0] + basis.right[0] * nx * tanHalf * aspect + basis.up[0] * ny * tanHalf,
        basis.forward[1] + basis.right[1] * nx * tanHalf * aspect + basis.up[1] * ny * tanHalf,
        basis.forward[2] + basis.right[2] * nx * tanHalf * aspect + basis.up[2] * ny * tanHalf,
      ])
      const hit = voxel.trace(basis.origin, dir, maxDist)
      let rgb: Rgb = [0.01, 0.012, 0.02]
      if (hit) {
        rgb = pipeline.shadeHit(hit, { gi })
      }
      const i = (y * width + x) * 4
      rgba[i] = toByte(rgb[0])
      rgba[i + 1] = toByte(rgb[1])
      rgba[i + 2] = toByte(rgb[2])
      rgba[i + 3] = 255
    }
  }
  return { width, height, rgba }
}

function toByte(value: number): number {
  const mapped = value / (1 + value)
  return Math.max(0, Math.min(255, Math.round(Math.pow(mapped, 1 / 2.2) * 255)))
}

export function pixelAt(frame: CpuFrame, x: number, y: number): Rgb {
  const i = (y * frame.width + x) * 4
  return [frame.rgba[i] ?? 0, frame.rgba[i + 1] ?? 0, frame.rgba[i + 2] ?? 0]
}

export function regionMean(frame: CpuFrame, x0: number, y0: number, x1: number, y1: number): Rgb {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const p = pixelAt(frame, x, y)
      r += p[0]
      g += p[1]
      b += p[2]
      n += 1
    }
  }
  const inv = n === 0 ? 0 : 1 / n
  return [r * inv, g * inv, b * inv]
}
