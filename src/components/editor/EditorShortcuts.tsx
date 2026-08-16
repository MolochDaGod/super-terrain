import { useEffect } from 'react'
import type { EditorStore, EditorTool } from '../../terrain/editor/EditorStore'

const TOOL_KEYS: Record<string, EditorTool> = {
  Digit1: 'select',
  Digit2: 'raise',
  Digit3: 'lower',
  Digit4: 'smooth',
  Digit5: 'flatten',
  Digit6: 'remesh',
  Digit7: 'tunnel',
}

export function EditorShortcuts({ editor }: { editor: EditorStore }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }
      const tool = TOOL_KEYS[event.code]
      if (tool) editor.patch({ tool, status: `${tool} tool active` })
      else if (event.code === 'KeyH') {
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
