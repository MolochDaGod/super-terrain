import { useCallback, useEffect, useRef } from 'react'
import type { EditorStore } from '../editor/EditorStore'

interface TransformDragSessionOptions {
  editor: EditorStore
  enabled: boolean
  ownerKey: string
  commit: () => void
  committedStatus: string
}

/**
 * Owns the editor-wide transform drag flag and guarantees that a transform is
 * committed even when TransformControls misses mouseUp because it unmounted,
 * lost focus, or the selected object changed under the pointer.
 */
export function useTransformDragSession({
  editor,
  enabled,
  ownerKey,
  commit,
  committedStatus,
}: TransformDragSessionOptions) {
  const active = useRef(false)
  const latestCommit = useRef(commit)
  const activeCommit = useRef(commit)
  const latestStatus = useRef(committedStatus)
  const activeStatus = useRef(committedStatus)
  latestCommit.current = commit
  latestStatus.current = committedStatus

  const finish = useCallback(() => {
    if (!active.current) return
    active.current = false
    try {
      activeCommit.current()
    } finally {
      editor.patch({
        dragging: false,
        status: activeStatus.current,
      })
    }
  }, [editor])

  const begin = useCallback(() => {
    if (active.current) return
    active.current = true
    activeCommit.current = latestCommit.current
    activeStatus.current = latestStatus.current
    editor.patch({ dragging: true })
  }, [editor])

  const isActive = useCallback(() => active.current, [])

  useEffect(() => {
    const finishFromWindow = () => finish()
    const finishWhenHidden = () => {
      if (document.visibilityState === 'hidden') finish()
    }
    window.addEventListener('pointerup', finishFromWindow)
    window.addEventListener('pointercancel', finishFromWindow)
    window.addEventListener('blur', finishFromWindow)
    window.addEventListener('pagehide', finishFromWindow)
    document.addEventListener('visibilitychange', finishWhenHidden)
    return () => {
      window.removeEventListener('pointerup', finishFromWindow)
      window.removeEventListener('pointercancel', finishFromWindow)
      window.removeEventListener('blur', finishFromWindow)
      window.removeEventListener('pagehide', finishFromWindow)
      document.removeEventListener('visibilitychange', finishWhenHidden)
    }
  }, [finish])

  useEffect(() => () => finish(), [finish, ownerKey])

  useEffect(() => {
    if (!enabled) finish()
  }, [enabled, finish])

  return { begin, finish, isActive }
}
