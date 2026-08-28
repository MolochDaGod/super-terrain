import { describe, expect, it } from 'vitest'
import { volumeIndex, worldToCell } from './cascades.ts'
import { IrradianceVolumeField } from './irradianceVolume.ts'
import { resolveGather, makeScreenCache } from './gatherFallback.ts'
import { WorldRadianceCache } from './spatialHash.ts'
import { encodeRadiance } from './sphericalHarmonics.ts'
import { DEFAULT_CACHE, DEFAULT_CASCADE } from './types.ts'

describe('final-gather fallback order', () => {
  const camera: [number, number, number] = [0, 0, 0]
  const query = {
    position: [0.4, 0.1, 0.2] as [number, number, number],
    normal: [0, 1, 0] as [number, number, number],
    rayDir: [0, 1, 0] as [number, number, number],
    frame: 4,
  }

  it('prefers screen-space, then radiance cache, then irradiance volumes', () => {
    const radiance = new WorldRadianceCache(DEFAULT_CACHE)
    radiance.insert(
      query.position,
      1,
      { radiance: [0, 1, 0], normal: [0, 1, 0], albedo: [0, 1, 0] },
      4,
    )
    const volumeConfig = { ...DEFAULT_CASCADE, resolution: 4, firstSize: 8 }
    const volumes = new IrradianceVolumeField(volumeConfig)
    const cell = worldToCell(query.position, 0, camera, volumeConfig)
    const ix = Math.min(3, Math.max(0, cell.ix))
    const iy = Math.min(3, Math.max(0, cell.iy))
    const iz = Math.min(3, Math.max(0, cell.iz))
    const blue = encodeRadiance([0, 1, 0], [0, 0, 4], 1)
    for (let dz = 0; dz <= 1; dz += 1) {
      for (let dy = 0; dy <= 1; dy += 1) {
        for (let dx = 0; dx <= 1; dx += 1) {
          const cx = Math.min(3, ix + dx)
          const cy = Math.min(3, iy + dy)
          const cz = Math.min(3, iz + dz)
          volumes.set(volumeIndex(0, cx, cy, cz, volumeConfig), blue)
        }
      }
    }

    const screenHit = resolveGather(query, {
      screen: makeScreenCache(() => [1, 0, 0]),
      radiance,
      volumes,
      camera,
    })
    expect(screenHit.source).toBe('screen-space')
    expect(screenHit.radiance).toEqual([1, 0, 0])

    const cacheHit = resolveGather(query, {
      screen: makeScreenCache(() => null),
      radiance,
      volumes,
      camera,
    })
    expect(cacheHit.source).toBe('radiance-cache')
    expect(cacheHit.radiance).toEqual([0, 1, 0])

    const emptyCache = new WorldRadianceCache(DEFAULT_CACHE)
    const volumeHit = resolveGather(query, {
      screen: makeScreenCache(() => null),
      radiance: emptyCache,
      volumes,
      camera,
    })
    expect(volumeHit.source).toBe('irradiance-volume')
    expect(volumeHit.radiance[2]).toBeGreaterThan(volumeHit.radiance[0])
  })

  it('returns miss/sky when every cache is empty', () => {
    const result = resolveGather(query, {
      radiance: new WorldRadianceCache(DEFAULT_CACHE),
      volumes: new IrradianceVolumeField({ ...DEFAULT_CASCADE, resolution: 2 }),
      camera,
      sky: [0.1, 0.2, 0.3],
    })
    expect(result.source).toBe('miss')
    expect(result.radiance).toEqual([0.1, 0.2, 0.3])
  })
})
