import {
  ClampToEdgeWrapping,
  Data3DTexture,
  FloatType,
  LinearFilter,
  NearestFilter,
  RGBAFormat,
  UnsignedByteType,
} from 'three/webgpu'
import { cascadeOrigin, cascadeSize } from '../cascades.ts'
import type { IrradianceVolumeField } from '../irradianceVolume.ts'
import type { WorldRadianceCache } from '../spatialHash.ts'
import type { CascadeConfig, Vec3 } from '../types.ts'
import type { VoxelGrid } from '../voxelGrid.ts'

export interface VolumeGpuTextures {
  l0: Data3DTexture
  lx: Data3DTexture
  ly: Data3DTexture
  lz: Data3DTexture
  voxel: Data3DTexture
  /** CPU splat of the Gautron hashed radiance cache into voxel cells. */
  radianceCache: Data3DTexture
  readonly resolution: number
  readonly cascadeCount: number
  readonly firstSize: number
}

function makeFloat3D(width: number, height: number, depth: number, name: string): Data3DTexture {
  const data = new Float32Array(width * height * depth * 4)
  const tex = new Data3DTexture(data, width, height, depth)
  tex.format = RGBAFormat
  tex.type = FloatType
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.wrapR = ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.unpackAlignment = 1
  tex.name = name
  tex.needsUpdate = true
  return tex
}

function makeByte3D(width: number, height: number, depth: number, name: string): Data3DTexture {
  const data = new Uint8Array(width * height * depth * 4)
  const tex = new Data3DTexture(data, width, height, depth)
  tex.format = RGBAFormat
  tex.type = UnsignedByteType
  tex.minFilter = NearestFilter
  tex.magFilter = NearestFilter
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.wrapR = ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.unpackAlignment = 1
  tex.name = name
  tex.needsUpdate = true
  return tex
}

export function createVolumeGpuTextures(
  config: CascadeConfig,
  voxel: VoxelGrid,
): VolumeGpuTextures {
  const res = config.resolution
  const depth = res * config.cascadeCount
  const radianceCache = makeFloat3D(
    voxel.resolution,
    voxel.resolution,
    voxel.resolution,
    'gi-radiance-cache',
  )
  radianceCache.minFilter = LinearFilter
  radianceCache.magFilter = LinearFilter
  return {
    l0: makeFloat3D(res, res, depth, 'gi-sh-l0'),
    lx: makeFloat3D(res, res, depth, 'gi-sh-lx'),
    ly: makeFloat3D(res, res, depth, 'gi-sh-ly'),
    lz: makeFloat3D(res, res, depth, 'gi-sh-lz'),
    voxel: makeByte3D(voxel.resolution, voxel.resolution, voxel.resolution, 'gi-voxels'),
    radianceCache,
    resolution: res,
    cascadeCount: config.cascadeCount,
    firstSize: config.firstSize,
  }
}

export function uploadVoxelTexture(tex: Data3DTexture, voxel: VoxelGrid): void {
  const data = tex.image.data as Uint8Array
  const n = voxel.resolution ** 3
  for (let i = 0; i < n; i += 1) {
    const o = i * 4
    data[o] = Math.round((voxel.albedo[i * 3] ?? 0) * 255)
    data[o + 1] = Math.round((voxel.albedo[i * 3 + 1] ?? 0) * 255)
    data[o + 2] = Math.round((voxel.albedo[i * 3 + 2] ?? 0) * 255)
    data[o + 3] = voxel.occupancy[i] ? 255 : 0
  }
  tex.needsUpdate = true
}

export function uploadVolumeTextures(
  textures: VolumeGpuTextures,
  volumes: IrradianceVolumeField,
): void {
  const res = textures.resolution
  const cascades = textures.cascadeCount
  const layer = res * res
  const pack = (tex: Data3DTexture, pick: (index: number) => [number, number, number]) => {
    const data = tex.image.data as Float32Array
    for (let cascade = 0; cascade < cascades; cascade += 1) {
      for (let iz = 0; iz < res; iz += 1) {
        for (let iy = 0; iy < res; iy += 1) {
          for (let ix = 0; ix < res; ix += 1) {
            const index = cascade * layer * res + iz * layer + iy * res + ix
            const rgb = pick(index)
            const o = (cascade * res + iz) * layer * 4 + iy * res * 4 + ix * 4
            data[o] = rgb[0]
            data[o + 1] = rgb[1]
            data[o + 2] = rgb[2]
            data[o + 3] = 1
          }
        }
      }
    }
    tex.needsUpdate = true
  }
  pack(textures.l0, (i) => volumes.current[i]?.l0 ?? [0, 0, 0])
  pack(textures.lx, (i) => volumes.current[i]?.lx ?? [0, 0, 0])
  pack(textures.ly, (i) => volumes.current[i]?.ly ?? [0, 0, 0])
  pack(textures.lz, (i) => volumes.current[i]?.lz ?? [0, 0, 0])
}

/**
 * Splats hashed cache entries into a dense 3D texture so the TSL gather can
 * sample world radiance at a hit without a GPU hash table.
 */
export function uploadRadianceCache(
  tex: Data3DTexture,
  cache: WorldRadianceCache,
  voxel: VoxelGrid,
): void {
  const data = tex.image.data as Float32Array
  data.fill(0)
  const base = cache.config.cellSize
  const r = voxel.resolution
  for (const entry of cache.entries) {
    if (!entry) continue
    const size = base * entry.lod
    const wx = (entry.ix + 0.5) * size
    const wy = (entry.iy + 0.5) * size
    const wz = (entry.iz + 0.5) * size
    const ix = Math.floor((wx - voxel.origin[0]) / voxel.cell)
    const iy = Math.floor((wy - voxel.origin[1]) / voxel.cell)
    const iz = Math.floor((wz - voxel.origin[2]) / voxel.cell)
    if (ix < 0 || iy < 0 || iz < 0 || ix >= r || iy >= r || iz >= r) continue
    const o = (iz * r * r + iy * r + ix) * 4
    data[o] = entry.radiance[0]
    data[o + 1] = entry.radiance[1]
    data[o + 2] = entry.radiance[2]
    data[o + 3] = 1
  }
  tex.needsUpdate = true
}

export function cascadeUniforms(camera: Vec3, config: CascadeConfig): {
  origins: number[]
  sizes: number[]
} {
  const origins: number[] = []
  const sizes: number[] = []
  for (let c = 0; c < config.cascadeCount; c += 1) {
    const o = cascadeOrigin(c, camera, config)
    origins.push(o[0], o[1], o[2])
    sizes.push(cascadeSize(c, config))
  }
  return { origins, sizes }
}
