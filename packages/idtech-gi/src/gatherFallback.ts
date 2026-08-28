import type { WorldRadianceCache } from './spatialHash.ts'
import type { IrradianceVolumeField } from './irradianceVolume.ts'
import { evaluateIrradiance } from './sphericalHarmonics.ts'
import type {
  GatherQuery,
  GatherResult,
  Rgb,
  ScreenSpaceCache,
  Vec3,
} from './types.ts'

export interface GatherCaches {
  screen?: ScreenSpaceCache
  radiance: WorldRadianceCache
  volumes: IrradianceVolumeField
  camera: Vec3
  sky?: Rgb
}

/**
 * Sousa final gather: 0 shading, caches only.
 * Fallback order is screen-space → world radiance cache → irradiance volumes.
 */
export function resolveGather(query: GatherQuery, caches: GatherCaches): GatherResult {
  const screen = caches.screen?.sample(query.position) ?? null
  if (screen) {
    return { radiance: [screen[0], screen[1], screen[2]], source: 'screen-space' }
  }

  const distance = Math.hypot(
    query.position[0] - caches.camera[0],
    query.position[1] - caches.camera[1],
    query.position[2] - caches.camera[2],
  )
  const cached = caches.radiance.sample(query.position, distance, query.frame)
  if (cached) {
    return { radiance: [cached[0], cached[1], cached[2]], source: 'radiance-cache' }
  }

  const sh = caches.volumes.sample(query.position, caches.camera)
  if (sh) {
    // Incoming radiance along the gather ray is the volume irradiance about the
    // surface the ray hit; using the hit normal keeps the SH directional.
    const incoming = evaluateIrradiance(sh, query.normal)
    if (incoming[0] + incoming[1] + incoming[2] > 1e-8) {
      return { radiance: incoming, source: 'irradiance-volume' }
    }
  }

  const sky = caches.sky ?? [0, 0, 0]
  return { radiance: [sky[0], sky[1], sky[2]], source: 'miss' }
}

export function projectScreenSample(
  position: Vec3,
  options: {
    viewProjection: (p: Vec3) => { x: number; y: number; z: number } | null
    depthAt: (x: number, y: number) => number | null
    radianceAt: (x: number, y: number) => Rgb | null
    width: number
    height: number
    thickness?: number
  },
): Rgb | null {
  const clip = options.viewProjection(position)
  if (!clip) return null
  if (clip.x < 0 || clip.x > 1 || clip.y < 0 || clip.y > 1 || clip.z < 0 || clip.z > 1) {
    return null
  }
  const px = Math.min(options.width - 1, Math.max(0, Math.floor(clip.x * options.width)))
  const py = Math.min(options.height - 1, Math.max(0, Math.floor(clip.y * options.height)))
  const depth = options.depthAt(px, py)
  if (depth === null) return null
  const thickness = options.thickness ?? 0.03
  if (Math.abs(depth - clip.z) > thickness) return null
  return options.radianceAt(px, py)
}

export function makeScreenCache(
  sample: (position: Vec3) => Rgb | null,
): ScreenSpaceCache {
  return { sample }
}
