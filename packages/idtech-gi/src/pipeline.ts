import { interleavedUpdateSet, type ProbeRef } from './cascades.ts'
import { resolveGather, type GatherCaches } from './gatherFallback.ts'
import { IrradianceVolumeField } from './irradianceVolume.ts'
import { INV_PI, TAU, cosineHemisphere, dot3, fibonacciSphere, interleavedGradientNoise, length3, normalize3, sub3 } from './math.ts'
import { WorldRadianceCache } from './spatialHash.ts'
import { encodeRadiance, emptySH, evaluateIrradiance } from './sphericalHarmonics.ts'
import {
  DEFAULT_CACHE,
  DEFAULT_CASCADE,
  addRgb,
  mulRgb,
  scaleRgb,
  type CascadeConfig,
  type GatherResult,
  type PointLight,
  type RadianceCacheConfig,
  type Rgb,
  type ScreenSpaceCache,
  type Vec3,
  type VisibilityHit,
  type SH2,
} from './types.ts'
import type { VoxelGrid } from './voxelGrid.ts'

export interface PipelineStats {
  frame: number
  cascade: number
  probesUpdated: number
  raysTraced: number
  cacheInserts: number
  cacheReuses: number
  hits: number
}

export interface SousaPipelineOptions {
  cascade?: CascadeConfig
  cache?: RadianceCacheConfig
  lights?: PointLight[]
  sky?: Rgb
  /** Mix of previous-frame volume into the newly traced SH (Sousa "add previous"). */
  volumeBlend?: number
  /** Max visibility ray length in world units. */
  maxRayDistance?: number
  probeStride?: number
}

/**
 * CPU Sousa frame: visibility from interleaved cell-center probes → spatially
 * hashed radiance cache (shaded, reused) → irradiance volumes with previous-
 * frame bounce → reduced-res cache-only final gather.
 *
 * Visibility is a voxel DDA so the rest of the pipeline does not depend on
 * hardware RT. The TSL path ports these same stages to compute.
 */
export class SousaPipeline {
  readonly cascade: CascadeConfig
  readonly cache: WorldRadianceCache
  readonly volumes: IrradianceVolumeField
  lights: PointLight[]
  sky: Rgb
  volumeBlend: number
  maxRayDistance: number
  probeStride: number
  frame = 0
  lastStats: PipelineStats = {
    frame: 0,
    cascade: 0,
    probesUpdated: 0,
    raysTraced: 0,
    cacheInserts: 0,
    cacheReuses: 0,
    hits: 0,
  }
  camera: Vec3 = [0, 0, 0]
  private readonly voxel: VoxelGrid

  constructor(voxel: VoxelGrid, options: SousaPipelineOptions = {}) {
    this.voxel = voxel
    this.cascade = options.cascade ?? { ...DEFAULT_CASCADE }
    this.cache = new WorldRadianceCache(options.cache ?? DEFAULT_CACHE)
    this.volumes = new IrradianceVolumeField(this.cascade)
    this.lights = options.lights ?? []
    this.sky = options.sky ?? [0.02, 0.03, 0.05]
    this.volumeBlend = options.volumeBlend ?? 0.35
    this.maxRayDistance = options.maxRayDistance ?? voxel.size * 1.5
    this.probeStride = options.probeStride ?? 1
  }

  /**
   * One budgeted frame. Updates one cascade (interleaved), shades new cache
   * entries with previous-frame volume irradiance, then writes the cascade.
   */
  step(camera: Vec3): PipelineStats {
    this.camera = camera
    const update = interleavedUpdateSet(
      this.frame,
      camera,
      this.cascade,
      this.probeStride,
    )
    let raysTraced = 0
    let cacheInserts = 0
    let cacheReuses = 0
    let hits = 0
    const rotate = this.frame * 0.37

    for (const probe of update.probes) {
      const voxel = this.voxel.worldToVoxel(probe.position)
      const ix = Math.floor(voxel[0])
      const iy = Math.floor(voxel[1])
      const iz = Math.floor(voxel[2])
      if (this.voxel.inBounds(ix, iy, iz) && this.voxel.occupancy[this.voxel.index(ix, iy, iz)]) {
        continue
      }
      const traced = this.traceProbe(probe, camera, rotate)
      raysTraced += this.cascade.raysPerProbe
      hits += traced.hits
      cacheInserts += traced.inserts
      cacheReuses += traced.reuses
      this.volumes.updateProbe(probe, traced.sh, this.volumeBlend)
    }

    this.volumes.advanceFrame()
    const stats: PipelineStats = {
      frame: this.frame,
      cascade: update.cascade,
      probesUpdated: update.probes.length,
      raysTraced,
      cacheInserts,
      cacheReuses,
      hits,
    }
    this.lastStats = stats
    this.frame += 1
    return stats
  }

  private traceProbe(
    probe: ProbeRef,
    camera: Vec3,
    rotate: number,
  ): { sh: SH2; hits: number; inserts: number; reuses: number } {
    const rays = this.cascade.raysPerProbe
    const solid = (4 * Math.PI) / rays
    const sh = emptySH()
    let hits = 0
    let inserts = 0
    let reuses = 0
    for (let ray = 0; ray < rays; ray += 1) {
      const dir = fibonacciSphere(rays, ray, rotate)
      const vis = this.voxel.trace(probe.position, dir, this.maxRayDistance)
      let radiance: Rgb
      if (!vis) {
        radiance = this.sky
      } else {
        hits += 1
        const distance = length3(sub3(vis.position, camera))
        const found = this.cache.lookup(vis.position, distance, this.frame)
        if (found.entry && found.reused) {
          reuses += 1
          radiance = found.entry.radiance
        } else {
          radiance = this.shadeHit(vis)
          this.cache.insert(
            vis.position,
            distance,
            { radiance, normal: vis.normal, albedo: vis.albedo },
            this.frame,
          )
          inserts += 1
        }
      }
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
    return { sh, hits, inserts, reuses }
  }

  /**
   * Shade a visibility hit: Lambert direct lights (voxel-shadowed) plus
   * previous-frame volume irradiance. That previous-frame term is the extra
   * bounce — we do not trace more rays (Sousa).
   */
  shadeHit(
    hit: Pick<VisibilityHit, 'position' | 'normal' | 'albedo'>,
    options: { gi?: boolean } = {},
  ): Rgb {
    const n = hit.normal
    const p = hit.position
    const albedo = hit.albedo
    let ev = [0, 0, 0] as Rgb
    for (const light of this.lights) {
      const toLight = sub3(light.position, p)
      const dist = length3(toLight)
      if (dist < 1e-4) continue
      const ldir = [toLight[0] / dist, toLight[1] / dist, toLight[2] / dist] as Vec3
      const ndotl = Math.max(0, dot3(n, ldir))
      if (ndotl <= 0) continue
      if (light.direction && light.coneCos !== undefined) {
        const toward = -ldir[0] * light.direction[0] - ldir[1] * light.direction[1] - ldir[2] * light.direction[2]
        if (toward < light.coneCos) continue
      }
      const origin: Vec3 = [
        p[0] + n[0] * this.voxel.cell * 0.6,
        p[1] + n[1] * this.voxel.cell * 0.6,
        p[2] + n[2] * this.voxel.cell * 0.6,
      ]
      if (this.voxel.occluded(origin, light.position)) continue
      const atten = light.intensity / (1 + dist * dist)
      ev = addRgb(ev, scaleRgb(mulRgb(light.color, albedo), ndotl * atten * INV_PI))
    }
    if (options.gi !== false) {
      const prev = this.volumes.sample(p, this.camera)
      if (prev) {
        const indirect = evaluateIrradiance(prev, n)
        ev = addRgb(ev, scaleRgb(mulRgb(albedo, indirect), INV_PI))
      }
    }
    return ev
  }

  sampleIndirect(position: Vec3, normal: Vec3, camera: Vec3): Rgb {
    const sh = this.volumes.sample(position, camera)
    if (!sh) return [0, 0, 0]
    return evaluateIrradiance(sh, normal)
  }

  gatherCaches(screen?: ScreenSpaceCache): GatherCaches {
    return {
      screen,
      radiance: this.cache,
      volumes: this.volumes,
      camera: this.camera,
      sky: this.sky,
    }
  }

  /**
   * Reduced-resolution, cache-only final gather for one surface sample.
   * One cosine-weighted ray, then the Sousa fallback order.
   */
  finalGather(
    position: Vec3,
    normal: Vec3,
    pixelX: number,
    pixelY: number,
    screen?: ScreenSpaceCache,
  ): GatherResult {
    const u = interleavedGradientNoise(pixelX, pixelY, this.frame)
    const v = interleavedGradientNoise(pixelX + 19, pixelY + 47, this.frame * 3)
    const dir = cosineHemisphere(normal, u, v)
    const origin: Vec3 = [
      position[0] + normal[0] * this.voxel.cell * 0.5,
      position[1] + normal[1] * this.voxel.cell * 0.5,
      position[2] + normal[2] * this.voxel.cell * 0.5,
    ]
    const vis = this.voxel.trace(origin, dir, this.maxRayDistance)
    const hitPos = vis?.position ?? addOffset(origin, dir, this.maxRayDistance)
    const hitN = vis?.normal ?? [-dir[0], -dir[1], -dir[2]] as Vec3
    return resolveGather(
      { position: hitPos, normal: hitN, rayDir: dir, frame: this.frame },
      this.gatherCaches(screen),
    )
  }

  /**
   * Encode one gather radiance sample as 2-band SH about the surface normal
   * (Sousa: each gather pixel is an irradiance probe).
   */
  gatherToSH(normal: Vec3, radiance: Rgb): SH2 {
    return encodeRadiance(normal, radiance, TAU / 2)
  }
}

function addOffset(origin: Vec3, dir: Vec3, distance: number): Vec3 {
  return [
    origin[0] + dir[0] * distance,
    origin[1] + dir[1] * distance,
    origin[2] + dir[2] * distance,
  ]
}

export function denoiseGatherSH(
  image: SH2[],
  width: number,
  height: number,
  depth: Float32Array,
  normals: Float32Array,
  radius = 2,
): SH2[] {
  const out: SH2[] = image.map((sh) => ({
    l0: [sh.l0[0], sh.l0[1], sh.l0[2]],
    lx: [sh.lx[0], sh.lx[1], sh.lx[2]],
    ly: [sh.ly[0], sh.ly[1], sh.ly[2]],
    lz: [sh.lz[0], sh.lz[1], sh.lz[2]],
  }))
  const sigmaZ = 0.08
  const sigmaN = 0.25
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      const z0 = depth[i] ?? 0
      const nx = normals[i * 3] ?? 0
      const ny = normals[i * 3 + 1] ?? 1
      const nz = normals[i * 3 + 2] ?? 0
      const acc = emptySH()
      let wsum = 0
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const j = yy * width + xx
          const dz = (depth[j] ?? 0) - z0
          const nd =
            nx * (normals[j * 3] ?? 0) +
            ny * (normals[j * 3 + 1] ?? 0) +
            nz * (normals[j * 3 + 2] ?? 0)
          const w =
            Math.exp((-dx * dx - dy * dy) / 8) *
            Math.exp(-(dz * dz) / (2 * sigmaZ * sigmaZ)) *
            Math.max(0, (nd - (1 - sigmaN)) / sigmaN)
          if (w <= 1e-5) continue
          const s = image[j]
          if (!s) continue
          acc.l0[0] += s.l0[0] * w
          acc.l0[1] += s.l0[1] * w
          acc.l0[2] += s.l0[2] * w
          acc.lx[0] += s.lx[0] * w
          acc.lx[1] += s.lx[1] * w
          acc.lx[2] += s.lx[2] * w
          acc.ly[0] += s.ly[0] * w
          acc.ly[1] += s.ly[1] * w
          acc.ly[2] += s.ly[2] * w
          acc.lz[0] += s.lz[0] * w
          acc.lz[1] += s.lz[1] * w
          acc.lz[2] += s.lz[2] * w
          wsum += w
        }
      }
      if (wsum > 1e-5) {
        const inv = 1 / wsum
        const d = out[i]
        if (!d) continue
        d.l0[0] = acc.l0[0] * inv
        d.l0[1] = acc.l0[1] * inv
        d.l0[2] = acc.l0[2] * inv
        d.lx[0] = acc.lx[0] * inv
        d.lx[1] = acc.lx[1] * inv
        d.lx[2] = acc.lx[2] * inv
        d.ly[0] = acc.ly[0] * inv
        d.ly[1] = acc.ly[1] * inv
        d.ly[2] = acc.ly[2] * inv
        d.lz[0] = acc.lz[0] * inv
        d.lz[1] = acc.lz[1] * inv
        d.lz[2] = acc.lz[2] * inv
      }
    }
  }
  return out
}

export function upscaleNearest<T>(
  src: T[],
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): T[] {
  const out: T[] = new Array(dstW * dstH)
  for (let y = 0; y < dstH; y += 1) {
    const sy = Math.min(srcH - 1, Math.floor((y + 0.5) * srcH / dstH))
    for (let x = 0; x < dstW; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor((x + 0.5) * srcW / dstW))
      out[y * dstW + x] = src[sy * srcW + sx] as T
    }
  }
  return out
}

export { normalize3 }
