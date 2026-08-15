import type { TerrainModifier } from '../modifiers/types'

export interface SerializedTerrainWorld {
  version: 1
  worldId: string
  savedAt: number
  modifiers: TerrainModifier[]
}

export function serializeWorld(
  worldId: string,
  modifiers: TerrainModifier[],
): string {
  const payload: SerializedTerrainWorld = {
    version: 1,
    worldId,
    savedAt: Date.now(),
    modifiers,
  }
  return JSON.stringify(payload)
}

export function deserializeWorld(serialized: string): SerializedTerrainWorld {
  const parsed = JSON.parse(serialized) as Partial<SerializedTerrainWorld>
  if (
    parsed.version !== 1 ||
    typeof parsed.worldId !== 'string' ||
    !Array.isArray(parsed.modifiers)
  ) {
    throw new Error('Unsupported or invalid terrain world data')
  }
  return parsed as SerializedTerrainWorld
}
