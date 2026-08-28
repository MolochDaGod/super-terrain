import { add3, scale3 } from './math.ts'
import type { Rgb, Vec3, VisibilityHit } from './types.ts'

export interface Voxel {
  albedo: Rgb
  normal: Vec3
  occupied: number
}

export interface VoxelHit {
  position: Vec3
  normal: Vec3
  albedo: Rgb
  distance: number
  ix: number
  iy: number
  iz: number
}

/**
 * Dense occupancy + albedo grid used as the swappable visibility backend.
 * Sousa traces hardware rays; WebGPU has no rayQuery, so probe visibility is
 * a voxel DDA against this grid (same cache architecture, different vis).
 */
export class VoxelGrid {
  readonly resolution: number
  readonly origin: Vec3
  readonly size: number
  readonly cell: number
  readonly occupancy: Uint8Array
  readonly albedo: Float32Array
  readonly normal: Float32Array

  constructor(resolution: number, origin: Vec3, size: number) {
    this.resolution = resolution
    this.origin = origin
    this.size = size
    this.cell = size / resolution
    const count = resolution * resolution * resolution
    this.occupancy = new Uint8Array(count)
    this.albedo = new Float32Array(count * 3)
    this.normal = new Float32Array(count * 3)
  }

  index(ix: number, iy: number, iz: number): number {
    const r = this.resolution
    return iz * r * r + iy * r + ix
  }

  inBounds(ix: number, iy: number, iz: number): boolean {
    const r = this.resolution
    return ix >= 0 && iy >= 0 && iz >= 0 && ix < r && iy < r && iz < r
  }

  worldToVoxel(p: Vec3): Vec3 {
    return [
      (p[0] - this.origin[0]) / this.cell,
      (p[1] - this.origin[1]) / this.cell,
      (p[2] - this.origin[2]) / this.cell,
    ]
  }

  voxelCenter(ix: number, iy: number, iz: number): Vec3 {
    return [
      this.origin[0] + (ix + 0.5) * this.cell,
      this.origin[1] + (iy + 0.5) * this.cell,
      this.origin[2] + (iz + 0.5) * this.cell,
    ]
  }

  setVoxel(ix: number, iy: number, iz: number, albedo: Rgb, normal: Vec3): void {
    if (!this.inBounds(ix, iy, iz)) return
    const i = this.index(ix, iy, iz)
    this.occupancy[i] = 1
    this.albedo[i * 3] = albedo[0]
    this.albedo[i * 3 + 1] = albedo[1]
    this.albedo[i * 3 + 2] = albedo[2]
    const len = Math.hypot(normal[0], normal[1], normal[2]) || 1
    this.normal[i * 3] = normal[0] / len
    this.normal[i * 3 + 1] = normal[1] / len
    this.normal[i * 3 + 2] = normal[2] / len
  }

  fillBox(min: Vec3, max: Vec3, albedo: Rgb, normal?: Vec3): void {
    const a = this.worldToVoxel(min)
    const b = this.worldToVoxel(max)
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0])))
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1])))
    const z0 = Math.max(0, Math.floor(Math.min(a[2], b[2])))
    const x1 = Math.min(this.resolution - 1, Math.floor(Math.max(a[0], b[0]) - 1e-6))
    const y1 = Math.min(this.resolution - 1, Math.floor(Math.max(a[1], b[1]) - 1e-6))
    const z1 = Math.min(this.resolution - 1, Math.floor(Math.max(a[2], b[2]) - 1e-6))
    const dx = max[0] - min[0]
    const dy = max[1] - min[1]
    const dz = max[2] - min[2]
    const auto: Vec3 = !normal
      ? dx <= dy && dx <= dz
        ? [Math.sign(max[0] + min[0]), 0, 0]
        : dy <= dz
          ? [0, Math.sign(max[1] + min[1]), 0]
          : [0, 0, Math.sign(max[2] + min[2])]
      : normal
    for (let iz = z0; iz <= z1; iz += 1) {
      for (let iy = y0; iy <= y1; iy += 1) {
        for (let ix = x0; ix <= x1; ix += 1) {
          this.setVoxel(ix, iy, iz, albedo, auto)
        }
      }
    }
  }

  /**
   * Amanatides & Woo DDA. Returns the first occupied voxel along the ray.
   * Face normal is taken from the axis we entered on, so a thin wall still
   * shades with a plausible orientation without storing extra data.
   */
  trace(origin: Vec3, dir: Vec3, maxDistance: number): VoxelHit | null {
    const r = this.resolution
    const cell = this.cell
    const ox = (origin[0] - this.origin[0]) / cell
    const oy = (origin[1] - this.origin[1]) / cell
    const oz = (origin[2] - this.origin[2]) / cell
    const dx = dir[0]
    const dy = dir[1]
    const dz = dir[2]
    let ix = Math.floor(ox)
    let iy = Math.floor(oy)
    let iz = Math.floor(oz)
    const stepX = dx >= 0 ? 1 : -1
    const stepY = dy >= 0 ? 1 : -1
    const stepZ = dz >= 0 ? 1 : -1
    const tDeltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx)
    const tDeltaY = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy)
    const tDeltaZ = dz === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dz)
    const nextVoxelX = dx >= 0 ? ix + 1 : ix
    const nextVoxelY = dy >= 0 ? iy + 1 : iy
    const nextVoxelZ = dz >= 0 ? iz + 1 : iz
    let tMaxX = dx === 0 ? Number.POSITIVE_INFINITY : (nextVoxelX - ox) / dx
    let tMaxY = dy === 0 ? Number.POSITIVE_INFINITY : (nextVoxelY - oy) / dy
    let tMaxZ = dz === 0 ? Number.POSITIVE_INFINITY : (nextVoxelZ - oz) / dz
    const tLimit = maxDistance / cell
    let t = 0
    let lastAxis: 0 | 1 | 2 = 0
    const maxSteps = r * 3
    for (let step = 0; step < maxSteps && t <= tLimit; step += 1) {
      if (ix >= 0 && iy >= 0 && iz >= 0 && ix < r && iy < r && iz < r) {
        const index = this.index(ix, iy, iz)
        if (this.occupancy[index]) {
          const distance = t * cell
          const n: Vec3 = [0, 0, 0]
          n[lastAxis] = lastAxis === 0 ? -stepX : lastAxis === 1 ? -stepY : -stepZ
          const stored: Vec3 = [
            this.normal[index * 3],
            this.normal[index * 3 + 1],
            this.normal[index * 3 + 2],
          ]
          const useStored = Math.abs(stored[0]) + Math.abs(stored[1]) + Math.abs(stored[2]) > 0.1
          const normal = useStored && stored[0] * n[0] + stored[1] * n[1] + stored[2] * n[2] >= 0
            ? stored
            : n
          const hitPos = add3(origin, scale3(dir, Math.max(distance, cell * 0.01)))
          return {
            position: hitPos,
            normal,
            albedo: [
              this.albedo[index * 3],
              this.albedo[index * 3 + 1],
              this.albedo[index * 3 + 2],
            ],
            distance,
            ix,
            iy,
            iz,
          }
        }
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        ix += stepX
        t = tMaxX
        tMaxX += tDeltaX
        lastAxis = 0
      } else if (tMaxY < tMaxZ) {
        iy += stepY
        t = tMaxY
        tMaxY += tDeltaY
        lastAxis = 1
      } else {
        iz += stepZ
        t = tMaxZ
        tMaxZ += tDeltaZ
        lastAxis = 2
      }
    }
    return null
  }

  occluded(from: Vec3, to: Vec3): boolean {
    const delta = [to[0] - from[0], to[1] - from[1], to[2] - from[2]] as Vec3
    const dist = Math.hypot(delta[0], delta[1], delta[2])
    if (dist < 1e-5) return false
    const dir: Vec3 = [delta[0] / dist, delta[1] / dist, delta[2] / dist]
    const hit = this.trace(from, dir, dist - this.cell * 0.25)
    return hit !== null
  }

  toVisibilityHit(
    hit: VoxelHit,
    probeIndex: number,
    rayIndex: number,
  ): VisibilityHit {
    return {
      position: hit.position,
      normal: hit.normal,
      albedo: hit.albedo,
      distance: hit.distance,
      probeIndex,
      rayIndex,
    }
  }
}

export function voxelizeBoxWalls(
  grid: VoxelGrid,
  innerMin: Vec3,
  innerMax: Vec3,
  thickness: number,
  walls: {
    nx?: Rgb
    px?: Rgb
    ny?: Rgb
    py?: Rgb
    nz?: Rgb
    pz?: Rgb
  },
): void {
  const t = thickness
  if (walls.nx) {
    grid.fillBox(
      [innerMin[0] - t, innerMin[1] - t, innerMin[2] - t],
      [innerMin[0], innerMax[1] + t, innerMax[2] + t],
      walls.nx,
      [1, 0, 0],
    )
  }
  if (walls.px) {
    grid.fillBox(
      [innerMax[0], innerMin[1] - t, innerMin[2] - t],
      [innerMax[0] + t, innerMax[1] + t, innerMax[2] + t],
      walls.px,
      [-1, 0, 0],
    )
  }
  if (walls.ny) {
    grid.fillBox(
      [innerMin[0] - t, innerMin[1] - t, innerMin[2] - t],
      [innerMax[0] + t, innerMin[1], innerMax[2] + t],
      walls.ny,
      [0, 1, 0],
    )
  }
  if (walls.py) {
    grid.fillBox(
      [innerMin[0] - t, innerMax[1], innerMin[2] - t],
      [innerMax[0] + t, innerMax[1] + t, innerMax[2] + t],
      walls.py,
      [0, -1, 0],
    )
  }
  if (walls.nz) {
    grid.fillBox(
      [innerMin[0] - t, innerMin[1] - t, innerMin[2] - t],
      [innerMax[0] + t, innerMax[1] + t, innerMin[2]],
      walls.nz,
      [0, 0, 1],
    )
  }
  if (walls.pz) {
    grid.fillBox(
      [innerMin[0] - t, innerMin[1] - t, innerMax[2]],
      [innerMax[0] + t, innerMax[1] + t, innerMax[2] + t],
      walls.pz,
      [0, 0, -1],
    )
  }
}
