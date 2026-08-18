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
        editor.patch({ tool, status: `${TOOL_BY_ID[tool].label} tool active` })
      } else if (event.code === 'KeyH') {
        editor.patch({ showHud: !editor.getSnapshot().showHud })
      } else if (event.code === 'BracketLeft') {
        editor.patch({ brushRadius: Math.max(4, editor.getSnapshot().brushRadius - 2) })
      } else if (event.code === 'BracketRight') {
        editor.patch({ brushRadius: Math.min(72, editor.getSnapshot().brushRadius + 2) })
      } else if (event.code === 'Escape') {
        editor.patch({ tool: 'select', showHelp: false, status: 'Inspect tool active' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editor])
  return null
}
