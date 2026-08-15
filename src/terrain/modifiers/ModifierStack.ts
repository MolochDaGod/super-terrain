import { intersects } from '../core/bounds'
import type { AABB } from '../core/types'
import type { TerrainModifier } from './types'

export class ModifierStack {
  private modifiers: TerrainModifier[] = []
  private revision = 0

  add<T extends TerrainModifier>(modifier: T): T {
    this.modifiers.push(modifier)
    this.modifiers.sort(compareModifiers)
    this.revision += 1
    return modifier
  }

  remove(id: string): TerrainModifier | undefined {
    const index = this.modifiers.findIndex((modifier) => modifier.id === id)
    if (index === -1) return undefined
    const [removed] = this.modifiers.splice(index, 1)
    this.revision += 1
    return removed
  }

  touch(): void {
    this.revision += 1
  }

  clear(): void {
    if (this.modifiers.length === 0) return
    this.modifiers = []
    this.revision += 1
  }

  replace(modifiers: TerrainModifier[]): void {
    this.modifiers = modifiers.map(cloneModifier).sort(compareModifiers)
    this.revision += 1
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
}

function compareModifiers(a: TerrainModifier, b: TerrainModifier): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  return a.id.localeCompare(b.id)
}

export function cloneModifier(modifier: TerrainModifier): TerrainModifier {
  if (modifier.type === 'brush-stroke') {
    return {
      ...modifier,
      bounds: { min: { ...modifier.bounds.min }, max: { ...modifier.bounds.max } },
      points: modifier.points.map((point) => ({ ...point })),
    }
  }
  if (
    modifier.type === 'remesh' ||
    modifier.type === 'tessellate' ||
    modifier.type === 'boolean-subtract'
  ) {
    return {
      ...modifier,
      bounds: { min: { ...modifier.bounds.min }, max: { ...modifier.bounds.max } },
      center: { ...modifier.center },
      ...(modifier.type === 'boolean-subtract'
        ? { direction: { ...modifier.direction } }
        : {}),
    } as TerrainModifier
  }
  return {
    ...modifier,
    bounds: { min: { ...modifier.bounds.min }, max: { ...modifier.bounds.max } },
  }
}
