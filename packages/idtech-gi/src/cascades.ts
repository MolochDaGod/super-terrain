import { DEFAULT_CASCADE, type CascadeConfig, type Vec3 } from './types.ts'

export interface ProbeRef {
  cascade: number
  ix: number
  iy: number
  iz: number
  /** Packed index: cascade * res^3 + iz * res^2 + iy * res + ix */
  index: number
  position: Vec3
}

export function cascadeSize(cascade: number, config: CascadeConfig): number {
  return config.firstSize * 2 ** cascade
}

export function cascadeCellSize(cascade: number, config: CascadeConfig): number {
  return cascadeSize(cascade, config) / config.resolution
}

/**
 * Snap the cascade origin so cell centers stay stable as the camera moves
 * (avoids swimming). Origin is the min corner of the volume.
 */
export function cascadeOrigin(
  cascade: number,
  camera: Vec3,
  config: CascadeConfig,
): Vec3 {
  const size = cascadeSize(cascade, config)
  const cell = cascadeCellSize(cascade, config)
  const half = size * 0.5
  const minX = camera[0] - half
  const minY = camera[1] - half
  const minZ = camera[2] - half
  return [
    Math.floor(minX / cell) * cell,
    Math.floor(minY / cell) * cell,
    Math.floor(minZ / cell) * cell,
  ]
}

/** Sousa: probes live at cell centers, not corners. */
export function cellCenter(
  cascade: number,
  ix: number,
  iy: number,
  iz: number,
  camera: Vec3,
  config: CascadeConfig,
): Vec3 {
  const origin = cascadeOrigin(cascade, camera, config)
  const cell = cascadeCellSize(cascade, config)
  return [
    origin[0] + (ix + 0.5) * cell,
    origin[1] + (iy + 0.5) * cell,
    origin[2] + (iz + 0.5) * cell,
  ]
}

export function packProbeIndex(
  cascade: number,
  ix: number,
  iy: number,
  iz: number,
  resolution: number,
): number {
  const layer = resolution * resolution
  return cascade * layer * resolution + iz * layer + iy * resolution + ix
}

export function unpackProbeIndex(
  index: number,
  resolution: number,
): { cascade: number; ix: number; iy: number; iz: number } {
  const perCascade = resolution * resolution * resolution
  const cascade = Math.floor(index / perCascade)
  const local = index - cascade * perCascade
  const layer = resolution * resolution
  const iz = Math.floor(local / layer)
  const rem = local - iz * layer
  const iy = Math.floor(rem / resolution)
  const ix = rem - iy * resolution
  return { cascade, ix, iy, iz }
}

export function totalProbes(config: CascadeConfig): number {
  return config.resolution ** 3 * config.cascadeCount
}

export function probesPerCascade(config: CascadeConfig): number {
  return config.resolution ** 3
}

/**
 * Interleaved update set: Sousa refreshes 1 cascade per frame. We also
 * checkerboard probes inside that cascade so the per-frame ray count stays
 * budgeted on large resolutions.
 */
export function interleavedUpdateSet(
  frame: number,
  camera: Vec3,
  config: CascadeConfig = DEFAULT_CASCADE,
  probeStride = 1,
): { cascade: number; probes: ProbeRef[] } {
  const cascadeCount = Math.max(1, config.cascadeCount)
  const perFrame = Math.max(1, config.cascadesPerFrame)
  const start = (frame * perFrame) % cascadeCount
  const cascade = start
  const res = config.resolution
  const stride = Math.max(1, probeStride)
  const phase = Math.floor(frame / cascadeCount) % stride
  const probes: ProbeRef[] = []
  for (let iz = 0; iz < res; iz += 1) {
    for (let iy = 0; iy < res; iy += 1) {
      for (let ix = 0; ix < res; ix += 1) {
        if (stride > 1 && (ix + iy * 3 + iz * 7) % stride !== phase) continue
        probes.push({
          cascade,
          ix,
          iy,
          iz,
          index: packProbeIndex(cascade, ix, iy, iz, res),
          position: cellCenter(cascade, ix, iy, iz, camera, config),
        })
      }
    }
  }
  return { cascade, probes }
}

export function volumeIndex(
  cascade: number,
  ix: number,
  iy: number,
  iz: number,
  config: CascadeConfig,
): number {
  const res = config.resolution
  return packProbeIndex(cascade, ix, iy, iz, res)
}

/** Finest cascade that still contains `world` relative to `camera`. */
export function cascadeForPoint(
  world: Vec3,
  camera: Vec3,
  config: CascadeConfig,
): number {
  const dx = Math.abs(world[0] - camera[0])
  const dy = Math.abs(world[1] - camera[1])
  const dz = Math.abs(world[2] - camera[2])
  const extent = Math.max(dx, dy, dz) * 2
  for (let cascade = 0; cascade < config.cascadeCount; cascade += 1) {
    if (extent <= cascadeSize(cascade, config) * 0.98) return cascade
  }
  return config.cascadeCount - 1
}

export function worldToCell(
  world: Vec3,
  cascade: number,
  camera: Vec3,
  config: CascadeConfig,
): { ix: number; iy: number; iz: number; fx: number; fy: number; fz: number } {
  const origin = cascadeOrigin(cascade, camera, config)
  const cell = cascadeCellSize(cascade, config)
  const gx = (world[0] - origin[0]) / cell - 0.5
  const gy = (world[1] - origin[1]) / cell - 0.5
  const gz = (world[2] - origin[2]) / cell - 0.5
  const ix = Math.floor(gx)
  const iy = Math.floor(gy)
  const iz = Math.floor(gz)
  return {
    ix,
    iy,
    iz,
    fx: gx - ix,
    fy: gy - iy,
    fz: gz - iz,
  }
}
