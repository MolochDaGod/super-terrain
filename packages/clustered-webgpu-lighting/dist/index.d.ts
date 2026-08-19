export interface ClusteredLightingInfo {
  implementation: 'local-forward-plus-clustered-lighting'
  maxLights: number
  tileSize: number
  zSlices: number
  maxLightsPerCluster: number
}

export const clusteredLightingInfo: ClusteredLightingInfo

export function installClusteredWebgpuLighting(
  renderer: object,
): void
