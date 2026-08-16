import type { TerrainModifier } from '../modifiers/types'

export interface SerializedTerrainWorld {
  version: 4
  worldId: string
  savedAt: number
  modifiers: TerrainModifier[]
}

export function serializeWorld(
  worldId: string,
  modifiers: TerrainModifier[],
): string {
  const payload: SerializedTerrainWorld = {
    version: 4,
    worldId,
    savedAt: Date.now(),
    modifiers,
  }
  return JSON.stringify(payload)
}

export function deserializeWorld(serialized: string): SerializedTerrainWorld {
  const parsed = JSON.parse(serialized) as {
    version?: number
    worldId?: string
    savedAt?: number
    modifiers?: TerrainModifier[]
  }
  if (
    (parsed.version !== 1 &&
      parsed.version !== 2 &&
      parsed.version !== 3 &&
      parsed.version !== 4) ||
    typeof parsed.worldId !== 'string' ||
    !Array.isArray(parsed.modifiers)
  ) {
    throw new Error('Unsupported or invalid terrain world data')
  }
  return {
    worldId: parsed.worldId,
    savedAt: parsed.savedAt ?? Date.now(),
    modifiers: parsed.modifiers,
    version: 4,
  }
}
