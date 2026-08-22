import { useEffect } from 'react'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { TOOL_BY_ID, TOOL_BY_KEY_CODE } from './tools'

export function EditorShortcuts({ editor }: { editor: EditorStore }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }
      const tool = TOOL_BY_KEY_CODE[event.code]
      if (tool) {
        editor.patch({
          tool,
          selectedLightId: undefined,
          status: `${TOOL_BY_ID[tool].label} tool active`,
        })
      } else if (event.code === 'KeyH') {
        editor.patch({ showHud: !editor.getSnapshot().showHud })
      } else if (event.code === 'BracketLeft') {
        patchActiveRadius(editor, -2)
      } else if (event.code === 'BracketRight') {
        patchActiveRadius(editor, 2)
      } else if (event.code === 'Escape') {
        editor.patch({
          tool: 'select',
          selectedLightId: undefined,
          showHelp: false,
          status: 'Inspect tool active',
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editor])
  return null
}

function patchActiveRadius(editor: EditorStore, delta: number): void {
  const snapshot = editor.getSnapshot()
  if (snapshot.tool === 'tunnel') {
    editor.patch({ tunnelRadius: Math.max(2, Math.min(128, snapshot.tunnelRadius + delta)) })
    return
  }
  if (snapshot.tool === 'dig') {
    editor.patch({ digRadius: Math.max(1, Math.min(64, snapshot.digRadius + delta)) })
    return
  }
  editor.patch({ brushRadius: Math.max(4, Math.min(72, snapshot.brushRadius + delta)) })
}
