import { useSyncExternalStore } from 'react'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'

export function useEditorSnapshot(editor: EditorStore) {
  return useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot)
}

export function useTerrainMetrics(terrain: WorldTerrain) {
  return useSyncExternalStore(
    terrain.metrics.subscribe,
    terrain.metrics.getSnapshot,
    terrain.metrics.getSnapshot,
  )
}

export function useModifierRevision(terrain: WorldTerrain) {
  return useSyncExternalStore(
    terrain.modifiers.subscribe,
    terrain.modifiers.getSnapshot,
    terrain.modifiers.getSnapshot,
  )
}

export function useGraniteRockRevision(terrain: WorldTerrain) {
  return useSyncExternalStore(
    terrain.rocks.subscribe,
    terrain.rocks.getSnapshot,
    terrain.rocks.getSnapshot,
  )
}

export function useWaterState(terrain: WorldTerrain) {
  return useSyncExternalStore(
    terrain.water.subscribe,
    terrain.water.getSnapshot,
    terrain.water.getSnapshot,
  )
}
