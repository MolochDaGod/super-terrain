import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Group, PerspectiveCamera, Vector2 } from 'three/webgpu'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import { ThreeTerrainRenderBackend } from '../rendering/ThreeTerrainRenderBackend'
import { BrushCursor } from './BrushCursor'

interface TerrainViewProps {
  terrain: WorldTerrain
  editor: EditorStore
}

export function TerrainView({ terrain, editor }: TerrainViewProps) {
  const group = useMemo(() => new Group(), [])
  const backend = useMemo(
    () => new ThreeTerrainRenderBackend(group, terrain.config.sectionSize),
    [group, terrain.config.sectionSize],
  )
  const { camera, gl, raycaster, size } = useThree()
  const pointer = useMemo(() => new Vector2(), [])
  const dragging = useRef(false)
  const activePointerId = useRef<number | null>(null)

  useEffect(() => {
    terrain.attachRenderer(backend)
    return () => {
      terrain.detachRenderer(backend)
      backend.dispose()
    }
  }, [backend, terrain])

  useEffect(() => {
    const canvas = gl.domElement

    const hitAt = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect()
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      )
      raycaster.setFromCamera(pointer, camera)
      return backend.raycast(raycaster)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (
        dragging.current &&
        activePointerId.current !== null &&
        event.pointerId !== activePointerId.current
      ) {
        return
      }
      const hit = hitAt(event)
      if (!hit) {
        if (dragging.current) terrain.pauseActiveStroke()
        if (!dragging.current) editor.hideCursor()
        return
      }
      editor.setCursor(hit.point, hit.normal, hit.sectionId)
      if (dragging.current) terrain.continueStroke(hit.point, hit.normal)
    }

    const onPointerDown = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        event.altKey ||
        !event.isPrimary ||
        dragging.current ||
        activePointerId.current !== null
      ) {
        return
      }
      const hit = hitAt(event)
      if (!hit) return
      const snapshot = editor.getSnapshot()
      editor.setCursor(hit.point, hit.normal, hit.sectionId)
      if (snapshot.tool === 'select') return
      event.preventDefault()
      event.stopPropagation()
      dragging.current = true
      activePointerId.current = event.pointerId
      editor.patch({ dragging: true })
      canvas.setPointerCapture(event.pointerId)
      const modifierId = terrain.beginStroke(hit.point, hit.normal, snapshot)
      if (modifierId) editor.patch({ selectedModifierId: modifierId })
    }

    const endPointer = (event: PointerEvent) => {
      if (
        !dragging.current ||
        activePointerId.current !== event.pointerId
      ) {
        return
      }
      dragging.current = false
      activePointerId.current = null
      const result = terrain.endStroke()
      editor.patch({
        dragging: false,
        status:
          result === 'cancelled'
            ? 'Tunnel cancelled · drag between two distinct surface portals'
            : 'Edit queued for background compile',
      })
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }

    const onPointerLeave = () => {
      if (!dragging.current) editor.hideCursor()
    }

    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', endPointer)
    canvas.addEventListener('pointercancel', endPointer)
    canvas.addEventListener('lostpointercapture', endPointer)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('contextmenu', preventContextMenu)
    return () => {
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', endPointer)
      canvas.removeEventListener('pointercancel', endPointer)
      canvas.removeEventListener('lostpointercapture', endPointer)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('contextmenu', preventContextMenu)
      if (dragging.current) terrain.endStroke()
      dragging.current = false
      activePointerId.current = null
    }
  }, [backend, camera, editor, gl.domElement, pointer, raycaster, terrain])

  useFrame((state, delta) => {
    const perspective = state.camera as PerspectiveCamera
    terrain.advanceActiveStroke(delta)
    terrain.update({
      camera: state.camera.position,
      viewportHeight: size.height,
      aspect: size.width / Math.max(1, size.height),
      verticalFovRadians: ((perspective.fov ?? 48) * Math.PI) / 180,
      frameMs: delta * 1000,
    })
  })

  return (
    <>
      <primitive object={group} />
      <BrushCursor editor={editor} />
    </>
  )
}

function preventContextMenu(event: Event): void {
  event.preventDefault()
}
