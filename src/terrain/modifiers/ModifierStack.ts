import { intersects } from '../core/bounds'
import type { AABB } from '../core/types'
import { cloneCutterVolume } from './boolean/CutterVolume'
import type { TerrainModifier } from './types'
import { cloneTerrainMaterialSettings } from '../rendering/materialSettings'
import { normalizeTunnelModifier } from './tunnel'
import { modifierWorldBounds, normalizedTransform } from './transform'

const MAX_BUCKETS_PER_MODIFIER = 256

export class ModifierStack {
  private modifiers: TerrainModifier[] = []
  private readonly bucketSize: number
  private buckets = new Map<number, Map<number, TerrainModifier[]>>()
  private globalModifiers: TerrainModifier[] = []
  private sculptLayers: TerrainModifier[] = []
  private indexDirty = true
  private queryEpoch = 0
  private seenAt = new WeakMap<TerrainModifier, number>()
  private nextSequence = 1
  private revision = 0
  private listeners = new Set<() => void>()
  private emitHandle?: number

  constructor(bucketSize = 128) {
    this.bucketSize = Math.max(1, bucketSize)
  }

  getSnapshot = (): number => this.revision

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  add<T extends TerrainModifier>(modifier: T): T {
    modifier.sequence = this.nextSequence
    this.nextSequence += 1
    modifier.transform = normalizedTransform(modifier.transform)
    modifier.bounds = modifierWorldBounds(modifier)
    this.modifiers.push(modifier)
    this.modifiers.sort(compareModifiers)
    this.indexDirty = true
    this.revision += 1
    this.emit()
    return modifier
  }

  remove(id: string): TerrainModifier | undefined {
    const index = this.modifiers.findIndex((modifier) => modifier.id === id)
    if (index === -1) return undefined
    const [removed] = this.modifiers.splice(index, 1)
    this.indexDirty = true
    this.revision += 1
    this.emit()
    return removed
  }

  touch(): void {
    // Modifiers are intentionally mutable while an editor gesture is active.
    // Defer rebuilding until a compile query actually arrives, so a long
    // stroke pays for one index update at commit rather than one per dab.
    this.indexDirty = true
    this.revision += 1
    this.emitSoon()
  }

  clear(): void {
    if (this.modifiers.length === 0) return
    this.modifiers = []
    this.buckets.clear()
    this.globalModifiers = []
    this.sculptLayers = []
    this.indexDirty = false
    this.revision += 1
    this.emit()
  }

  replace(modifiers: TerrainModifier[]): void {
    // The incoming array is already in evaluation order, so it is the record of
    // how the edits were authored -- including for worlds saved before the
    // order was tracked explicitly.
    const restored = modifiers.map(cloneModifier)
    for (const modifier of restored) {
      modifier.sequence = this.nextSequence
      this.nextSequence += 1
    }
    this.modifiers = restored.sort(compareModifiers)
    this.indexDirty = true
    this.revision += 1
    this.emit()
  }

  get(id: string): TerrainModifier | undefined {
    return this.modifiers.find((modifier) => modifier.id === id)
  }

  query(bounds: AABB): TerrainModifier[] {
    this.ensureSpatialIndex()
    this.queryEpoch += 1
    if (this.queryEpoch >= Number.MAX_SAFE_INTEGER) {
      this.queryEpoch = 1
      this.seenAt = new WeakMap()
    }
    const epoch = this.queryEpoch
    const result = [...this.sculptLayers]
    for (const modifier of this.globalModifiers) {
      if (intersects(modifier.bounds, bounds)) result.push(modifier)
    }
    const minimumX = Math.floor(bounds.min.x / this.bucketSize)
    const maximumX = Math.floor(bounds.max.x / this.bucketSize)
    const minimumZ = Math.floor(bounds.min.z / this.bucketSize)
    const maximumZ = Math.floor(bounds.max.z / this.bucketSize)

    for (let z = minimumZ; z <= maximumZ; z += 1) {
      const row = this.buckets.get(z)
      if (!row) continue
      for (let x = minimumX; x <= maximumX; x += 1) {
        const bucket = row.get(x)
        if (!bucket) continue
        for (const modifier of bucket) {
          if (this.seenAt.get(modifier) === epoch) continue
          this.seenAt.set(modifier, epoch)
          if (intersects(modifier.bounds, bounds)) result.push(modifier)
        }
      }
    }
    result.sort(compareModifiers)
    return result
  }

  snapshot(): TerrainModifier[] {
    return this.modifiers.map(cloneModifier)
  }

  get count(): number {
    return this.modifiers.length
  }

  get sourceRevision(): number {
    return this.revision
  }

  private emit(): void {
    this.emitHandle = undefined
    for (const listener of this.listeners) listener()
  }

  /**
   * Notifies at most once per frame.
   *
   * A live stroke mutates its modifier several times per pointer event, and
   * every notification re-renders the panels that list the stack. Only the
   * newest revision can matter to a frame that has not been drawn yet.
   */
  private emitSoon(): void {
    if (this.emitHandle !== undefined) return
    if (typeof requestAnimationFrame !== 'function') {
      this.emit()
      return
    }
    this.emitHandle = requestAnimationFrame(() => this.emit())
  }

  private ensureSpatialIndex(): void {
    if (!this.indexDirty) return
    this.indexDirty = false
    this.buckets.clear()
    this.globalModifiers = []
    this.sculptLayers = []
    for (const modifier of this.modifiers) {
      if (modifier.type === 'sculpt-layer') {
        this.sculptLayers.push(modifier)
        continue
      }
      if (!modifier.enabled || modifier.type === 'material-settings') continue
      const minimumX = Math.floor(modifier.bounds.min.x / this.bucketSize)
      const maximumX = Math.floor(modifier.bounds.max.x / this.bucketSize)
      const minimumZ = Math.floor(modifier.bounds.min.z / this.bucketSize)
      const maximumZ = Math.floor(modifier.bounds.max.z / this.bucketSize)
      const bucketCount =
        (maximumX - minimumX + 1) * (maximumZ - minimumZ + 1)
      if (!Number.isFinite(bucketCount) || bucketCount > MAX_BUCKETS_PER_MODIFIER) {
        this.globalModifiers.push(modifier)
        continue
      }
      for (let z = minimumZ; z <= maximumZ; z += 1) {
        let row = this.buckets.get(z)
        if (!row) {
          row = new Map()
          this.buckets.set(z, row)
        }
        for (let x = minimumX; x <= maximumX; x += 1) {
          const bucket = row.get(x)
          if (bucket) bucket.push(modifier)
          else row.set(x, [modifier])
        }
      }
    }
  }
}

function compareModifiers(a: TerrainModifier, b: TerrainModifier): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  const sequenceA = a.sequence ?? Number.MAX_SAFE_INTEGER
  const sequenceB = b.sequence ?? Number.MAX_SAFE_INTEGER
  if (sequenceA !== sequenceB) return sequenceA - sequenceB
  return a.id.localeCompare(b.id)
}

export function cloneModifier(modifier: TerrainModifier): TerrainModifier {
  const transform = normalizedTransform(modifier.transform)
  if (modifier.type === 'brush-stroke') {
    const clone: TerrainModifier = {
      ...modifier,
      domain: modifier.domain ?? 'heightfield',
      transform,
      bounds: { min: { ...modifier.bounds.min }, max: { ...modifier.bounds.max } },
      points: modifier.points.map((point) => ({
        ...point,
        normal: { ...(point.normal ?? { x: 0, y: 1, z: 0 }) },
        weight: point.weight ?? 1,
      })),
    }
    clone.bounds = modifierWorldBounds(clone)
    return clone
  }
  if (modifier.type === 'weight-paint') {
    const clone: TerrainModifier = {
      ...modifier,
      transform,
      bounds: { min: { ...modifier.bounds.min }, max: { ...modifier.bounds.max } },
      points: modifier.points.map((point) => ({
        ...point,
        normal: { ...point.normal },
        weight: point.weight ?? 1,
      })),
    }
    clone.bounds = modifierWorldBounds(clone)
    return clone
  }
  if (modifier.type === 'material-settings') {
    return {
      ...modifier,
      transform,
      bounds: { min: { ...modifier.bounds.min }, max: { ...modifier.bounds.max } },
      settings: cloneTerrainMaterialSettings(modifier.settings),
    }
  }
  if (modifier.type === 'boolean-subtract') {
    const normalized = normalizeTunnelModifier(modifier)
    const clone: TerrainModifier = {
      ...normalized,
      transform,
      bounds: {
        min: { ...normalized.bounds.min },
        max: { ...normalized.bounds.max },
      },
      portals: normalized.portals.map((portal) => ({
        ...portal,
        normal: { ...portal.normal },
      })) as typeof normalized.portals,
      carves: normalized.carves?.map(cloneCutterVolume),
    }
    clone.bounds = modifierWorldBounds(clone)
    return clone
  }
  if (modifier.type === 'boolean-volume') {
    const clone: TerrainModifier = {
      ...modifier,
      operation: modifier.operation ?? 'subtract',
      transform,
      bounds: {
        min: { ...modifier.bounds.min },
        max: { ...modifier.bounds.max },
      },
      volumes: modifier.volumes.map(cloneCutterVolume),
    }
    clone.bounds = modifierWorldBounds(clone)
    return clone
  }
  if (modifier.type === 'remesh' || modifier.type === 'tessellate') {
    const clone = {
      ...modifier,
      transform,
      bounds: { min: { ...modifier.bounds.min }, max: { ...modifier.bounds.max } },
      center: { ...modifier.center },
    } as TerrainModifier
    clone.bounds = modifierWorldBounds(clone)
    return clone
  }
  const clone = {
    ...modifier,
    transform,
    bounds: { min: { ...modifier.bounds.min }, max: { ...modifier.bounds.max } },
  }
  clone.bounds = modifierWorldBounds(clone)
  return clone
}
