import type { TreeVec3 } from './types'

export interface SpatialEntry {
  position: TreeVec3
  radius: number
}

interface RadiusTier<T> {
  maximumRadius: number
  cellSize: number
  buckets: Map<string, T[]>
}

/**
 * Deterministic uniform grid used by the collision and contact passes.
 *
 * The entries a tree puts in here span four orders of magnitude — a two-metre
 * bole sample and a five-millimetre twig sample live in the same field — and a
 * single grid cannot serve both. A query has to reach far enough to find
 * anything whose *own* radius might bring it into contact, so one grid sized
 * against the widest entry made every twig sweep a sphere the size of the
 * trunk. On a crown of several hundred shoots that is the dominant cost of
 * generating the tree.
 *
 * Splitting by radius fixes it: each tier knows its own widest member, so a
 * twig asking the twig tier searches centimetres and only asks the handful of
 * trunk-scale entries for a wide radius.
 */
export class SpatialIndex<T extends SpatialEntry> {
  readonly maximumRadius: number
  readonly entries: readonly T[]
  private readonly tiers: RadiusTier<T>[] = []

  constructor(entries: readonly T[], cellSize = 1.5) {
    this.entries = entries
    let maximumRadius = 0
    for (const entry of entries) maximumRadius = Math.max(maximumRadius, entry.radius)
    this.maximumRadius = maximumRadius

    // Octave tiers down from the widest entry. Four covers the whole range a
    // tree produces; anything below the last threshold shares the finest grid.
    const thresholds = [
      maximumRadius * 0.5,
      maximumRadius * 0.125,
      maximumRadius * 0.03125,
      0,
    ]
    for (const threshold of thresholds) {
      this.tiers.push({ maximumRadius: 0, cellSize, buckets: new Map() })
      void threshold
    }
    for (const entry of entries) {
      let tier = this.tiers.length - 1
      for (let index = 0; index < thresholds.length; index += 1) {
        if (entry.radius > thresholds[index]!) {
          tier = index
          break
        }
      }
      const target = this.tiers[tier]!
      target.maximumRadius = Math.max(target.maximumRadius, entry.radius)
    }
    for (const tier of this.tiers) {
      // Cells scale with the tier, not with one global number. A query into a
      // tier always reaches about that tier's own widest member, so sizing the
      // cells to match keeps every lookup inside a 3x3x3 neighbourhood. A fixed
      // small cell for the trunk tier meant a twig walked over a thousand empty
      // cells to find the two entries that mattered.
      tier.cellSize = Math.max(cellSize * 0.34, tier.maximumRadius * 2.2)
    }
    for (const entry of entries) {
      let tier = this.tiers.length - 1
      for (let index = 0; index < thresholds.length; index += 1) {
        if (entry.radius > thresholds[index]!) {
          tier = index
          break
        }
      }
      const target = this.tiers[tier]!
      const key = cellKey(entry.position, target.cellSize)
      const bucket = target.buckets.get(key)
      if (bucket) bucket.push(entry)
      else target.buckets.set(key, [entry])
    }
  }

  /** Everything within `radius` of `point`, regardless of entry size. */
  query(point: TreeVec3, radius: number): T[] {
    const result: T[] = []
    for (const tier of this.tiers) collectTier(tier, point, radius, result)
    return result
  }

  /**
   * Everything that could touch a sphere of `radius` at `point`.
   *
   * Each tier is searched only as far as its own widest member can reach, which
   * is the whole reason the tiers exist.
   */
  queryContacts(point: TreeVec3, radius: number, clearance: number): T[] {
    const result: T[] = []
    for (const tier of this.tiers) {
      if (tier.buckets.size === 0) continue
      collectTier(tier, point, (radius + tier.maximumRadius) * clearance, result)
    }
    return result
  }
}

function cellKey(point: TreeVec3, cellSize: number): string {
  return `${Math.floor(point.x / cellSize)}|${Math.floor(point.y / cellSize)}|` +
    `${Math.floor(point.z / cellSize)}`
}

function collectTier<T>(
  tier: RadiusTier<T>,
  point: TreeVec3,
  radius: number,
  result: T[],
): void {
  if (tier.buckets.size === 0) return
  const size = tier.cellSize
  const minimumX = Math.floor((point.x - radius) / size)
  const maximumX = Math.floor((point.x + radius) / size)
  const minimumY = Math.floor((point.y - radius) / size)
  const maximumY = Math.floor((point.y + radius) / size)
  const minimumZ = Math.floor((point.z - radius) / size)
  const maximumZ = Math.floor((point.z + radius) / size)
  for (let x = minimumX; x <= maximumX; x += 1) {
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let z = minimumZ; z <= maximumZ; z += 1) {
        const bucket = tier.buckets.get(`${x}|${y}|${z}`)
        if (bucket) result.push(...bucket)
      }
    }
  }
}
