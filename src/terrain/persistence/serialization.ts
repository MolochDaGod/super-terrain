import type { TerrainModifier } from '../modifiers/types'
import type { GraniteRock } from '../rocks/types'

export interface SerializedTerrainWorld {
  version: 6
  worldId: string
  savedAt: number
  modifiers: TerrainModifier[]
  rocks: GraniteRock[]
}

export function serializeWorld(
  worldId: string,
  modifiers: TerrainModifier[],
  rocks: GraniteRock[] = [],
): string {
  return JSON.stringify(createSerializedWorld(worldId, modifiers, rocks))
}

export function createSerializedWorld(
  worldId: string,
  modifiers: TerrainModifier[],
  rocks: GraniteRock[] = [],
): SerializedTerrainWorld {
  return {
    version: 6,
    worldId,
    savedAt: Date.now(),
    modifiers,
    rocks,
  }
}

export function deserializeWorld(
  serialized: string | SerializedTerrainWorld,
): SerializedTerrainWorld {
  const parsed = (typeof serialized === 'string'
    ? JSON.parse(serialized)
    : serialized) as {
    version?: number
    worldId?: string
    savedAt?: number
    modifiers?: TerrainModifier[]
    rocks?: GraniteRock[]
  }
  if (
    ![1, 2, 3, 4, 5, 6].includes(parsed.version ?? -1) ||
    typeof parsed.worldId !== 'string' ||
    !Array.isArray(parsed.modifiers) ||
    (parsed.rocks !== undefined && !Array.isArray(parsed.rocks))
  ) {
    throw new Error('Unsupported or invalid terrain world data')
  }
  return {
    worldId: parsed.worldId,
    savedAt: parsed.savedAt ?? Date.now(),
    modifiers: parsed.modifiers,
    rocks: parsed.rocks ?? [],
    version: 6,
  }
}
