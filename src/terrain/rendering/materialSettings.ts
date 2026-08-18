export type TerrainPaintChannelId = 'channel0' | 'channel1' | 'channel2' | 'channel3'

export interface TerrainMaterialChannel {
  id: TerrainPaintChannelId
  name: string
  color: number
  roughness: number
}

export interface TerrainMaterialSettings {
  channels: readonly [
    TerrainMaterialChannel,
    TerrainMaterialChannel,
    TerrainMaterialChannel,
    TerrainMaterialChannel,
  ]
}

export const DEFAULT_TERRAIN_MATERIAL_SETTINGS: TerrainMaterialSettings = {
  channels: [
    { id: 'channel0', name: 'Grass', color: 0x4f7d32, roughness: 0.94 },
    { id: 'channel1', name: 'Rock', color: 0x77736c, roughness: 0.82 },
    { id: 'channel2', name: 'Soil', color: 0x604733, roughness: 0.91 },
    { id: 'channel3', name: 'Snow', color: 0xdce4ee, roughness: 0.68 },
  ],
}

export function cloneTerrainMaterialSettings(
  settings: TerrainMaterialSettings = DEFAULT_TERRAIN_MATERIAL_SETTINGS,
): TerrainMaterialSettings {
  const channels = settings.channels.map((channel, index) => ({
    id: (`channel${index}` as TerrainPaintChannelId),
    name: channel.name || `Channel ${index + 1}`,
    color: Math.max(0, Math.min(0xffffff, Math.round(channel.color))),
    roughness: Math.max(0.05, Math.min(1, channel.roughness)),
  })) as unknown as TerrainMaterialSettings['channels']
  return { channels }
}

export function paintChannelIndex(channel: TerrainPaintChannelId): number {
  return Number(channel.at(-1)) || 0
}
