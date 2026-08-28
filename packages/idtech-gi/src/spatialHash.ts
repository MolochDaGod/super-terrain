import { hashCombine, hashInt } from './math.ts'
import {
  DEFAULT_CACHE,
  type RadianceCacheConfig,
  type RadianceCacheEntry,
  type Rgb,
  type Vec3,
  zeroRgb,
} from './types.ts'

export interface CacheCellKey {
  ix: number
  iy: number
  iz: number
  lod: number
}

/**
 * Sousa / Gautron spatial hash: 1D table indexed by a hash of quantized world
 * position + LOD, collisions resolved by a short linear probe.
 */
export function cellLod(distanceToCamera: number, lodDistance: number): number {
  const ratio = Math.max(0, distanceToCamera) / Math.max(lodDistance, 1e-4)
  const lod = 2 ** Math.floor(Math.log2(1 + ratio))
  return Math.max(1, lod)
}

export function quantizePosition(
  position: Vec3,
  config: RadianceCacheConfig,
  distanceToCamera: number,
): CacheCellKey {
  const lod = cellLod(distanceToCamera, config.lodDistance)
  const size = config.cellSize * lod
  return {
    ix: Math.floor(position[0] / size),
    iy: Math.floor(position[1] / size),
    iz: Math.floor(position[2] / size),
    lod,
  }
}

/** Nested hash from the Sousa slides. */
export function hashCellKey(key: CacheCellKey): number {
  return hashInt(
    key.lod + hashCombine(key.iz, hashCombine(key.iy, hashInt(key.ix))),
  )
}

export function cellChecksum(key: CacheCellKey): number {
  const value = hashCombine(
    key.lod + 1,
    hashCombine(key.iz, hashCombine(key.iy, hashInt(key.ix + 0x9e3779b9))),
  )
  return value === 0 ? 1 : value
}

export interface CacheLookup {
  index: number
  entry: RadianceCacheEntry | null
  reused: boolean
}

export class WorldRadianceCache {
  readonly config: RadianceCacheConfig
  readonly entries: (RadianceCacheEntry | null)[]
  occupied = 0

  constructor(config: RadianceCacheConfig = DEFAULT_CACHE) {
    this.config = config
    this.entries = new Array<RadianceCacheEntry | null>(config.maxCells).fill(null)
  }

  indexOf(key: CacheCellKey): number {
    return hashCellKey(key) % this.config.maxCells
  }

  lookupKey(key: CacheCellKey, frame = 0): CacheLookup {
    const start = this.indexOf(key)
    const checksum = cellChecksum(key)
    const { maxCells, probeSteps, reuseFrames } = this.config
    for (let step = 0; step < probeSteps; step += 1) {
      const index = (start + step) % maxCells
      const entry = this.entries[index]
      if (!entry) return { index, entry: null, reused: false }
      if (entry.checksum === checksum) {
        const age = frame - entry.frame
        return { index, entry, reused: age >= 0 && age <= reuseFrames }
      }
    }
    return { index: start, entry: null, reused: false }
  }

  lookup(
    position: Vec3,
    distanceToCamera: number,
    frame = 0,
  ): CacheLookup {
    return this.lookupKey(quantizePosition(position, this.config, distanceToCamera), frame)
  }

  /**
   * Insert or reuse a cell. Matching recent cells are left in place (Sousa
   * reuses ~20k updates over N frames). Expired or empty slots are claimed.
   */
  insert(
    position: Vec3,
    distanceToCamera: number,
    payload: {
      radiance: Rgb
      normal: Vec3
      albedo: Rgb
    },
    frame: number,
  ): CacheLookup {
    const key = quantizePosition(position, this.config, distanceToCamera)
    const found = this.lookupKey(key, frame)
    if (found.entry && found.reused) return found

    const start = found.index
    const checksum = cellChecksum(key)
    const { maxCells, probeSteps, reuseFrames } = this.config
    let slot = start
    let claimed = false
    for (let step = 0; step < probeSteps; step += 1) {
      const index = (start + step) % maxCells
      const entry = this.entries[index]
      if (!entry || entry.checksum === checksum || frame - entry.frame > reuseFrames) {
        slot = index
        claimed = true
        break
      }
    }
    if (!claimed) {
      // Table is locally full: overwrite the hashed slot rather than drop the sample.
      slot = start
    }
    const previous = this.entries[slot]
    if (!previous) this.occupied += 1
    this.entries[slot] = {
      checksum,
      lod: key.lod,
      ix: key.ix,
      iy: key.iy,
      iz: key.iz,
      radiance: [payload.radiance[0], payload.radiance[1], payload.radiance[2]],
      normal: [payload.normal[0], payload.normal[1], payload.normal[2]],
      albedo: [payload.albedo[0], payload.albedo[1], payload.albedo[2]],
      frame,
    }
    return { index: slot, entry: this.entries[slot], reused: false }
  }

  /** Rewrite radiance of an existing cell after shading. */
  shade(index: number, radiance: Rgb, frame: number): void {
    const entry = this.entries[index]
    if (!entry) return
    entry.radiance = [radiance[0], radiance[1], radiance[2]]
    entry.frame = frame
  }

  sample(position: Vec3, distanceToCamera: number, frame: number): Rgb | null {
    const found = this.lookup(position, distanceToCamera, frame)
    if (!found.entry || !found.reused) return null
    return found.entry.radiance
  }

  clear(): void {
    this.entries.fill(null)
    this.occupied = 0
  }
}

export function emptyRadiance(frame = 0): RadianceCacheEntry {
  return {
    checksum: 0,
    lod: 1,
    ix: 0,
    iy: 0,
    iz: 0,
    radiance: zeroRgb(),
    normal: [0, 1, 0],
    albedo: [1, 1, 1],
    frame,
  }
}
