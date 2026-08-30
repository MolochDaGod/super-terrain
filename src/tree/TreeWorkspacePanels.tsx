import { useEffect } from 'react'
import type { EditorStore } from '../terrain/editor/EditorStore'
import type { FoliageEditorStore } from '../foliage/FoliageEditorStore'
import type { TreeEditorStore } from './TreeEditorStore'
import { TreeInspectorPanel } from './ui/TreeInspectorPanel'
import { TreePerformanceHud } from './ui/TreePerformanceHud'
import { TreeScenePanel } from './ui/TreeScenePanel'
import { TreeQuickControls, TreeStatusBar } from './ui/TreeStatusBar'
import { TreeToolbar } from './ui/TreeToolbar'
import {
  TREE_TOOL_BY_KEY_CODE,
  setTreeWorkspaceTool,
} from './ui/treeTools'

/**
 * The forest workspace's chrome, in the terrain editor's arrangement: a menu
 * bar, one toolbar, the scene on the left, the selection on the right, and a
 * status line along the bottom.
 *
 * What it replaced was six independently positioned overlays — a tool bar and a
 * brush bar that overlapped each other, a catalogue that also held the forest
 * generator, an inspector, a render-toggle bar floating over the ground and a
 * status chip in the corner — with no shared column, no shared vocabulary of
 * sections and two separate ideas of what "the current tool" meant.
 */
export function TreeWorkspacePanels({
  editor,
  store,
  foliage,
}: {
  editor: EditorStore
  store: TreeEditorStore
  foliage: FoliageEditorStore
}) {
  return (
    <>
      <TreeToolbar store={store} foliage={foliage} />
      <TreeScenePanel store={store} foliage={foliage} />
      <TreeInspectorPanel store={store} foliage={foliage} />
      <TreeQuickControls store={store} />
      <TreePerformanceHud store={store} />
      <TreeStatusBar editor={editor} store={store} foliage={foliage} />
      <TreeEditorShortcuts store={store} foliage={foliage} />
    </>
  )
}

function TreeEditorShortcuts({
  store,
  foliage,
}: {
  store: TreeEditorStore
  foliage: FoliageEditorStore
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'd') {
          event.preventDefault()
          store.duplicateSelected()
        }
        return
      }

      const tool = TREE_TOOL_BY_KEY_CODE[event.code]
      if (tool) {
        setTreeWorkspaceTool(store, foliage, tool)
        return
      }

      if (event.key === 'Escape') {
        setTreeWorkspaceTool(store, foliage, 'select')
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        store.deleteSelected()
        return
      }
      // The brush size keys the ground palette has always had, kept working
      // from anywhere in the workspace rather than only while the old floating
      // brush bar was mounted.
      if (event.key === '[' || event.key === ']') {
        const current = foliage.getSnapshot()
        const step = current.radius * (event.key === '[' ? -0.18 : 0.18)
        foliage.patch({
          radius: Math.min(60, Math.max(0.5, current.radius + step)),
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [foliage, store])
  return null
}
