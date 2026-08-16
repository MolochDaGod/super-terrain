import { intersects } from '../core/bounds'
import type { AABB } from '../core/types'
import type { TerrainModifier } from './types'
import { normalizeTunnelModifier } from './tunnel'
import { modifierWorldBounds, normalizedTransform } from './transform'

export class ModifierStack {
  private modifiers: TerrainModifier[] = []
  private revision = 0
  private listeners = new Set<() => void>()

  getSnapshot = (): number => this.revision

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  add<T extends TerrainModifier>(modifier: T): T {
    modifier.transform = normalizedTransform(modifier.transform)
    modifier.bounds = modifierWorldBounds(modifier)
    this.modifiers.push(modifier)
    this.modifiers.sort(compareModifiers)
    this.revision += 1
    this.emit()
    return modifier
  }

  remove(id: string): TerrainModifier | undefined {
    const index = this.modifiers.findIndex((modifier) => modifier.id === id)
    if (index === -1) return undefined
    const [removed] = this.modifiers.splice(index, 1)
    this.revision += 1
    this.emit()
    return removed
  }

  touch(): void {
    this.revision += 1
    this.emit()
  }

  clear(): void {
    if (this.modifiers.length === 0) return
    this.modifiers = []
    this.revision += 1
    this.emit()
  }

  replace(modifiers: TerrainModifier[]): void {
    this.modifiers = modifiers.map(cloneModifier).sort(compareModifiers)
    this.revision += 1
    this.emit()
  }

  get(id: string): TerrainModifier | undefined {
    return this.modifiers.find((modifier) => modifier.id === id)
  }

  query(bounds: AABB): TerrainModifier[] {
    return this.modifiers.filter(
      (modifier) => modifier.enabled && intersects(modifier.bounds, bounds),
    )
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
    for (const listener of this.listeners) listener()
  }
}

function compareModifiers(a: TerrainModifier, b: TerrainModifier): number {
  if (a.priority !== b.priority) return a.priority - b.priority
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
