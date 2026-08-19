import * as THREE from "three/webgpu"
import { ClusteredLighting } from "./clustered-lighting.ts"

const clusteredLightingConfig = {
  maxLights: 1024,
  tileSize: 32,
  zSlices: 24,
  maxLightsPerCluster: 64,
}

type LightingRenderer = THREE.WebGPURenderer & {
  lighting?: unknown
  userData: Record<string, unknown>
}

export const clusteredLightingInfo = {
  implementation: 'local-forward-plus-clustered-lighting',
  ...clusteredLightingConfig,
}

export function installClusteredWebgpuLighting(renderer: THREE.WebGPURenderer): void {
  const target = renderer as LightingRenderer
  target.userData ??= {}
  target.lighting = new ClusteredLighting(
    clusteredLightingConfig.maxLights,
    clusteredLightingConfig.tileSize,
    clusteredLightingConfig.zSlices,
    clusteredLightingConfig.maxLightsPerCluster,
  )
  target.userData.clusteredWebgpuLighting = clusteredLightingInfo
}
