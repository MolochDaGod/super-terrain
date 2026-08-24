import { useSyncExternalStore } from 'react'
import type { TreeEditorStore } from './TreeEditorStore'

export function useTreeEditorSnapshot(store: TreeEditorStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
