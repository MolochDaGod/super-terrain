import { ExternalStore } from '../core/ExternalStore'
import { WATER_LEVEL } from '../compiler/climate'
import { sampleShowcaseRiver } from '../compiler/heightField'
import type { AABB, Vec3Like } from '../core/types'

/**
 * Where the world has standing water.
 *
 * Water is a painted coverage field rather than a polygon or a per-body object.
 * Two reasons: the shoreline is already produced by the terrain cutting the
 * water plane, so a body only needs to say *where it is allowed to be*; and a
 * coverage field is the only representation a brush can edit continuously —
 * adding a bay is one stroke, and it stays correct when the ground under it is
 * sculpted afterwards.
 *
 * The grid is coarse on purpose. The visible waterline comes from the height
 * field at metre resolution; the mask only decides which basins are flooded at
 * all, and a finer grid would spend memory on an edge nobody ever sees.
 */

/**
 * Metres per mask cell.
 *
 * Eight metres is the point where a hand-painted lake edge stops reading as a
 * staircase on flat ground. Where there is real relief the terrain cuts the
 * shoreline instead and the mask is never seen, so this is sized for the worst
 * case rather than the common one. Four kilometres of world at this pitch is a
 * megabyte of coverage — cheap next to a single section's mesh.
 */
export const WATER_CELL_SIZE = 8

export interface WaterState {
  /** Whether water is rendered at all. */
  enabled: boolean
  /** World Y of the surface, in metres. */
  level: number
  /** How murky the shallows read. 0 is clear meltwater, 1 is glacial flour. */
  turbidity: number
  /** Bumped whenever the mask changes, so the surface mesh can rebuild. */
  revision: number
}

export type WaterPaintMode = 'add' | 'remove'

export class WaterStore extends ExternalStore<WaterState> {
  readonly cellSize = WATER_CELL_SIZE
  readonly columns: number
  readonly origin: number
  /** Coverage per cell, 0..1. */
  readonly coverage: Float32Array
  private painted = 0

  constructor(worldSize: number) {
    super({ enabled: true, level: WATER_LEVEL, turbidity: 0.35, revision: 1 })
    this.columns = Math.max(2, Math.ceil(worldSize / WATER_CELL_SIZE) + 1)
    this.origin = -worldSize / 2
    this.coverage = new Float32Array(this.columns * this.columns)
  }

  get hasWater(): boolean {
    return this.getSnapshot().enabled && this.painted > 0
  }

  patch(values: Partial<WaterState>): void {
    this.update((current) => ({ ...current, ...values }))
  }

  /**
   * Flood the demo's authored outlet corridor.
   *
   * The shipped scene's river is a property of its height field, so the mask it
   * starts from is read back out of that field rather than stored: a showcase
   * world and a hand-painted world then use exactly the same rendering path.
   */
  seedFromRiver(seed: number): void {
    for (let row = 0; row < this.columns; row += 1) {
      const z = this.origin + row * this.cellSize
      for (let column = 0; column < this.columns; column += 1) {
        const x = this.origin + column * this.cellSize
        const bed = sampleShowcaseRiver(x, z, seed)
        if (bed <= 0.001) continue
        this.coverage[row * this.columns + column] = 1
      }
    }
    this.recount()
    this.bump()
  }

  clear(): void {
    this.coverage.fill(0)
    this.painted = 0
    this.bump()
  }

  /** Paint coverage under a brush. Returns true when anything actually changed. */
  paint(
    center: Vec3Like,
    radius: number,
    strength: number,
    mode: WaterPaintMode,
  ): boolean {
    const minColumn = Math.max(0, Math.floor((center.x - radius - this.origin) / this.cellSize))
    const maxColumn = Math.min(this.columns - 1, Math.ceil((center.x + radius - this.origin) / this.cellSize))
    const minRow = Math.max(0, Math.floor((center.z - radius - this.origin) / this.cellSize))
    const maxRow = Math.min(this.columns - 1, Math.ceil((center.z + radius - this.origin) / this.cellSize))
    const radiusSq = radius * radius
    let changed = false
    for (let row = minRow; row <= maxRow; row += 1) {
      const z = this.origin + row * this.cellSize
      for (let column = minColumn; column <= maxColumn; column += 1) {
        const x = this.origin + column * this.cellSize
        const distanceSq = (x - center.x) ** 2 + (z - center.z) ** 2
        if (distanceSq > radiusSq) continue
        // A soft edge, so a lake margin is a gradient the surface can fade
        // across instead of a ring of square cells.
        const falloff = 1 - Math.sqrt(distanceSq) / radius
        const step = strength * (0.35 + falloff * 0.65)
        const index = row * this.columns + column
        const previous = this.coverage[index]!
        const next = mode === 'add'
          ? Math.min(1, previous + step)
          : Math.max(0, previous - step)
        if (next === previous) continue
        this.coverage[index] = next
        changed = true
      }
    }
    if (changed) {
      this.recount()
      this.bump()
    }
    return changed
  }

  /** Bilinear coverage at a world point, 0..1. */
  sample(x: number, z: number): number {
    const cx = (x - this.origin) / this.cellSize
    const cz = (z - this.origin) / this.cellSize
    const column = Math.floor(cx)
    const row = Math.floor(cz)
    if (column < 0 || row < 0 || column >= this.columns - 1 || row >= this.columns - 1) {
      return 0
    }
    const fx = cx - column
    const fz = cz - row
    const index = row * this.columns + column
    const a = this.coverage[index]!
    const b = this.coverage[index + 1]!
    const c = this.coverage[index + this.columns]!
    const d = this.coverage[index + this.columns + 1]!
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz
  }

  /**
   * World extent worth meshing, or undefined when nothing is flooded.
   *
   * The surface mesh is built over this rather than over the world, because a
   * four-kilometre plane at shoreline resolution is millions of vertices for a
   * pond.
   */
  bounds(): AABB | undefined {
    if (this.painted === 0) return undefined
    let minColumn = this.columns
    let maxColumn = -1
    let minRow = this.columns
    let maxRow = -1
    for (let row = 0; row < this.columns; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        if (this.coverage[row * this.columns + column]! <= 0.002) continue
        if (column < minColumn) minColumn = column
        if (column > maxColumn) maxColumn = column
        if (row < minRow) minRow = row
        if (row > maxRow) maxRow = row
      }
    }
    if (maxColumn < 0) return undefined
    const level = this.getSnapshot().level
    // One cell of margin, so the coverage gradient has somewhere to fade out.
    const margin = this.cellSize
    return {
      min: {
        x: this.origin + minColumn * this.cellSize - margin,
        y: level,
        z: this.origin + minRow * this.cellSize - margin,
      },
      max: {
        x: this.origin + maxColumn * this.cellSize + margin,
        y: level,
        z: this.origin + maxRow * this.cellSize + margin,
      },
    }
  }

  /** Serialized form for local persistence. Coverage quantized to a byte per cell. */
  serialize(): { state: WaterState; coverage: string } {
    const bytes = new Uint8Array(this.coverage.length)
    for (let index = 0; index < this.coverage.length; index += 1) {
      bytes[index] = Math.round(this.coverage[index]! * 255)
    }
    let binary = ''
    const chunk = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
    }
    return { state: this.getSnapshot(), coverage: btoa(binary) }
  }

  restore(payload: { state?: Partial<WaterState>; coverage?: string }): void {
    if (payload.coverage) {
      try {
        const binary = atob(payload.coverage)
        const limit = Math.min(binary.length, this.coverage.length)
        for (let index = 0; index < limit; index += 1) {
          this.coverage[index] = binary.charCodeAt(index) / 255
        }
      } catch {
        this.coverage.fill(0)
      }
    }
    this.recount()
    this.patch({ ...payload.state, revision: this.getSnapshot().revision + 1 })
  }

  private recount(): void {
    let painted = 0
    for (const value of this.coverage) if (value > 0.002) painted += 1
    this.painted = painted
  }

  private bump(): void {
    this.patch({ revision: this.getSnapshot().revision + 1 })
  }
}
