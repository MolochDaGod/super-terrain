import { useSyncExternalStore } from 'react'
import type { ForestFieldSnapshot, ForestFieldStore } from '../ForestFieldStore'

export function useForestFieldSnapshot(store: ForestFieldStore): ForestFieldSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
