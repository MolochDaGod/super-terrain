import type { Material } from 'three/webgpu'
import { createTerrainMaterial } from './createTerrainMaterial'
import {
  createFullTerrainMaterial,
  type FullMaterialDebug,
} from './full/createFullTerrainMaterial'
import type { TerrainRenderMode } from './renderModes'
import {
  DEFAULT_TERRAIN_MATERIAL_SETTINGS,
  type TerrainMaterialSettings,
} from './materialSettings'

export interface TerrainMaterialHandle {
  material: Material
  /** Fast procedural pass, sufficient for an interactive full-mode render. */
  previewReady: Promise<void>
  /** Final full-resolution procedural maps. */
  ready: Promise<void>
  dispose(): void
}

export type TerrainMaterialReadiness = Pick<
  TerrainMaterialHandle,
  'previewReady' | 'ready'
>

/** Single place that maps a render mode onto its terrain surface material. */
export function createTerrainMaterialForMode(
  mode: TerrainRenderMode,
  debug: FullMaterialDebug = 'none',
  settings: TerrainMaterialSettings = DEFAULT_TERRAIN_MATERIAL_SETTINGS,
): TerrainMaterialHandle {
  if (mode === 'full') {
    return createFullTerrainMaterial({ debug, materialSettings: settings })
  }
  const preview = createTerrainMaterial(settings)
  const ready = Promise.resolve()
  return { ...preview, previewReady: ready, ready }
}
