import { useEffect, type RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import type { TransformControls as TransformControlsImpl } from 'three-stdlib'

interface TransformControlsRuntime {
  dragging: boolean
  onPointerDown: (event: PointerEvent) => void
  pointerMove: (pointer: { x: number; y: number; button: number }) => void
}

/**
 * Three's TransformControls listens for drag movement on document. Some
 * pointer-capture paths in the editor can prevent that listener from seeing a
 * usable move event. Forwarding the move during capture keeps the gizmo in
 * control and normalizes the button value TransformControls requires.
 */
export function useTransformControlsPointerBridge(
  controlsRef: RefObject<TransformControlsImpl | null>,
) {
  const canvas = useThree((state) => state.gl.domElement)

  useEffect(() => {
    const claimTransformPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) return
      const controls = controlsRef.current as unknown as TransformControlsRuntime | null
      if (!controls) return

      // TransformControls normally listens on the canvas bubble phase. By
      // then R3F objects or editor hit proxies may already have handled the
      // pointer. Probe the gizmo in capture phase and, only when it starts a
      // drag, keep the event away from terrain, CSG previews and camera input.
      controls.onPointerDown(event)
      if (!controls.dragging) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }

    const forwardPointerMove = (event: PointerEvent) => {
      const controls = controlsRef.current as unknown as TransformControlsRuntime | null
      if (!controls?.dragging) return

      const bounds = canvas.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0) return

      controls.pointerMove({
        x: ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        y: -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
        button: -1,
      })
    }

    canvas.addEventListener('pointerdown', claimTransformPointerDown, true)
    window.addEventListener('pointermove', forwardPointerMove, true)
    return () => {
      canvas.removeEventListener('pointerdown', claimTransformPointerDown, true)
      window.removeEventListener('pointermove', forwardPointerMove, true)
    }
  }, [canvas, controlsRef])
}
