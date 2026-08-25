import { useSyncExternalStore } from 'react'
import type { FoliageEditorStore } from '../FoliageEditorStore'

export function useFoliageSnapshot(store: FoliageEditorStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
