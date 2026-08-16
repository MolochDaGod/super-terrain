import type { Material } from 'three/webgpu'
import { createTerrainMaterial } from './createTerrainMaterial'
import {
  createFullTerrainMaterial,
  type FullMaterialDebug,
} from './full/createFullTerrainMaterial'
import type { TerrainRenderMode } from './renderModes'

export interface TerrainMaterialHandle {
  material: Material
  dispose(): void
}

/** Single place that maps a render mode onto its terrain surface material. */
export function createTerrainMaterialForMode(
  mode: TerrainRenderMode,
  debug: FullMaterialDebug = 'none',
): TerrainMaterialHandle {
  return mode === 'full'
    ? createFullTerrainMaterial({ debug })
    : createTerrainMaterial()
}
