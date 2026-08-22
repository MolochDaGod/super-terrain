import { useEffect } from 'react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore, TransformMode } from '../../terrain/editor/EditorStore'
import { TOOL_BY_ID, TOOL_BY_KEY_CODE } from './tools'
import {
  adjustBrushRadius,
  clearSelection,
  currentSelection,
  deleteSelection,
  duplicateSelection,
  focusSelection,
  saveWorld,
  toggleSelectionVisible,
} from './editorActions'

/** Unity-style transform keys. Ignored in fly mode, where W and E move the camera. */
const TRANSFORM_KEYS: Record<string, TransformMode | undefined> = {
  KeyW: 'translate',
  KeyE: 'rotate',
  KeyR: 'scale',
}

export function EditorShortcuts({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      const accelerator = event.metaKey || event.ctrlKey
      if (accelerator) {
        if (event.code === 'KeyS') {
          event.preventDefault()
          void saveWorld(terrain, editor)
        } else if (event.code === 'KeyD') {
          event.preventDefault()
          duplicateSelection(terrain, editor)
        }
        return
      }

      const snapshot = editor.getSnapshot()

      if (event.altKey) {
        // Alt is the orbit-while-editing modifier, so only the one binding
        // that reads as a menu accelerator is claimed here.
        if (event.code === 'KeyH') {
          event.preventDefault()
          toggleSelectionVisible(terrain, editor)
        }
        return
      }

      const transform = TRANSFORM_KEYS[event.code]
      if (transform && snapshot.cameraMode !== 'fly') {
        editor.patch({ transformMode: transform, tool: 'select' })
        return
      }

      const tool = TOOL_BY_KEY_CODE[event.code]
      // Fly mode owns the letter keys — WASD to move, Q/E for altitude — so a
      // letter shortcut there would change the tool under a camera that is
      // being flown. The digits are unclaimed and keep working.
      if (tool && !(snapshot.cameraMode === 'fly' && event.code.startsWith('Key'))) {
        editor.patch({ tool, status: `${TOOL_BY_ID[tool].label} tool active` })
        return
      }

      switch (event.code) {
        case 'KeyH':
          editor.patch({ showHud: !snapshot.showHud })
          break
        case 'KeyF':
          focusSelection(terrain, editor)
          break
        case 'Delete':
        case 'Backspace':
          deleteSelection(terrain, editor)
          break
        case 'Slash':
          if (event.shiftKey) editor.patch({ showHelp: !snapshot.showHelp })
          break
        case 'BracketLeft':
          adjustBrushRadius(editor, -2)
          break
        case 'BracketRight':
          adjustBrushRadius(editor, 2)
          break
        case 'Escape':
          // One escape hatch, applied in the order the user expects to undo
          // state: close whatever is open, then drop the selection, then the
          // 3D cursor, then fall back to the camera.
          if (snapshot.showWelcome) editor.patch({ showWelcome: false })
          else if (snapshot.showNewWorld) editor.patch({ showNewWorld: false })
          else if (snapshot.showHelp) editor.patch({ showHelp: false })
          else if (currentSelection(terrain, snapshot)) clearSelection(editor)
          else if (snapshot.worldCursor) {
            editor.patch({ worldCursor: undefined, status: '3D cursor cleared' })
          } else editor.patch({ tool: 'camera', status: 'Camera tool active' })
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editor, terrain])
  return null
}
