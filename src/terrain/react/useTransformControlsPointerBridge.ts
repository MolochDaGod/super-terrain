import { useEffect, type RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import type { TransformControls as TransformControlsImpl } from 'three-stdlib'

interface TransformControlsRuntime {
  dragging: boolean
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

    window.addEventListener('pointermove', forwardPointerMove, true)
    return () => window.removeEventListener('pointermove', forwardPointerMove, true)
  }, [canvas, controlsRef])
}
