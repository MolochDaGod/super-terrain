import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PerspectiveCamera, Vector2, type Group } from 'three/webgpu'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import { ThreeTerrainRenderBackend } from '../rendering/ThreeTerrainRenderBackend'
import { BrushCursor } from './BrushCursor'
import { WorldCursorMarker } from './WorldCursorMarker'
import { pickTargetOf, type PickTarget } from './pickTarget'
import { useEditorSnapshot } from './hooks'

interface TerrainViewProps {
  terrain: WorldTerrain
  editor: EditorStore
  group: Group
  backend: ThreeTerrainRenderBackend
}

export function TerrainView({
  terrain,
  editor,
  group,
  backend,
}: TerrainViewProps) {
  const { camera, gl, raycaster, scene, size } = useThree()
  const { cameraMode, renderMode } = useEditorSnapshot(editor)
  const pointer = useMemo(() => new Vector2(), [])
  const dragging = useRef(false)
  /** What the current drag is authoring, so pointer-up ends the right thing. */
  const dragKind = useRef<'terrain' | 'water'>('terrain')
  const activePointerId = useRef<number | null>(null)

  useEffect(() => {
    terrain.attachRenderer(backend)
    return () => {
      terrain.detachRenderer(backend)
      backend.dispose()
    }
  }, [backend, terrain])

  useEffect(() => {
    const readiness = backend.setRenderMode(renderMode)
    if (renderMode !== 'full') return

    let active = true
    let previewLoaded = false
    let failureReported = false
    editor.patch({ status: 'Generating procedural terrain textures…' })

    const reportFailure = () => {
      if (!active || failureReported) return
      failureReported = true
      editor.patch({
        status: previewLoaded
          ? 'Full quality active · 1K texture refinement failed'
          : 'Procedural texture bake failed · using colour fallback',
      })
    }

    void readiness.previewReady.then(() => {
      if (!active) return
      previewLoaded = true
      editor.patch({
        status: 'Full quality active · refining procedural textures…',
      })
    }, reportFailure)
    void readiness.ready.then(() => {
      if (!active) return
      editor.patch({ status: 'Full quality ready · procedural textures baked' })
    }, reportFailure)

    return () => {
      active = false
    }
  }, [backend, editor, renderMode])

  useEffect(() => {
    const canvas = gl.domElement

    const castFrom = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect()
      pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      )
      raycaster.setFromCamera(pointer, camera)
    }

    const hitAt = (event: PointerEvent) => {
      castFrom(event)
      return backend.raycast(raycaster)
    }

    /**
     * The nearest selectable object under the pointer.
     *
     * Resolved from the same ray as the terrain hit so the two can be compared:
     * an object is only picked when it is actually in front of the ground
     * behind it, and clicking past everything is unambiguously "nothing".
     */
    const pickAt = () => {
      for (const intersection of raycaster.intersectObjects(scene.children, true)) {
        const target = pickTargetOf(intersection.object)
        if (target) return { target, distance: intersection.distance }
      }
      return undefined
    }

    const nameOf = (target: PickTarget): string => {
      if (target.kind === 'rock') return terrain.rocks.get(target.id)?.name ?? 'Rock'
      if (target.kind === 'light') {
        return (
          editor.getSnapshot().lights.find((light) => light.id === target.id)?.name ??
          'Light'
        )
      }
      return terrain.modifiers.get(target.id) ? 'Modifier' : 'Object'
    }

    const placeWorldCursor = (event: PointerEvent) => {
      const hit = hitAt(event)
      if (!hit) return false
      editor.patch({
        worldCursor: { ...hit.point },
        status: `3D cursor at ${hit.point.x.toFixed(0)}, ${hit.point.y.toFixed(0)}, ${hit.point.z.toFixed(0)}`,
      })
      return true
    }

    const paintWater = (event: PointerEvent) => {
      const hit = hitAt(event)
      if (!hit) return
      const snapshot = editor.getSnapshot()
      editor.setCursor(hit.point, hit.normal, hit.sectionId)
      terrain.water.paint(
        hit.point,
        snapshot.waterRadius,
        snapshot.waterStrength * 0.5,
        snapshot.waterMode,
      )
      if (snapshot.waterMode === 'add' && !terrain.water.getSnapshot().enabled) {
        terrain.water.patch({ enabled: true })
      }
    }

    /**
     * Flooding dry ground that sits above the water level would paint a mask
     * nobody can see, because the surface is a level plane and the ground would
     * still be over it. On the very first stroke into a dry world the level has
     * no authored meaning yet, so it is taken from where the user asked for
     * water; after that it is a value they own and is left alone.
     */
    const primeWaterLevel = (event: PointerEvent) => {
      const water = terrain.water
      if (water.hasWater) return
      const hit = hitAt(event)
      if (!hit) return
      water.patch({ level: hit.point.y + 2, enabled: true })
      editor.patch({ status: `Water level set to ${(hit.point.y + 2).toFixed(0)} m` })
    }

    /**
     * Pointer work runs at most once per frame.
     *
     * A pointer can report far faster than the display refreshes -- a 1000 Hz
     * mouse delivers well over a dozen events per frame -- and every report
     * here casts a ray, writes the 3D cursor into the editor store, and, while
     * dragging, appends dabs and re-runs the viewport preview over them. None
     * of that can be seen more often than the display refreshes.
     *
     * A live stroke loses nothing by being coalesced: the segment between the
     * last processed position and the newest one is still resampled at brush
     * spacing, so the dab path is the same one a raw event stream would author.
     */
    let hoverEvent: PointerEvent | undefined
    let hoverHandle: number | undefined
    const runHover = () => {
      hoverHandle = undefined
      const event = hoverEvent
      hoverEvent = undefined
      if (event) applyPointerMove(event)
    }
    const onPointerMove = (event: PointerEvent) => {
      hoverEvent = event
      if (hoverHandle !== undefined) return
      hoverHandle = requestAnimationFrame(runHover)
    }

    const applyPointerMove = (event: PointerEvent) => {
      const snapshot = editor.getSnapshot()
      if (snapshot.cameraMode === 'fly' || snapshot.uiViewMode === 'clean') {
        editor.hideCursor()
        return
      }
      if (snapshot.dragging && !dragging.current) return
      if (
        dragging.current &&
        activePointerId.current !== null &&
        event.pointerId !== activePointerId.current
      ) {
        return
      }
      if (dragging.current && dragKind.current === 'water') {
        paintWater(event)
        return
      }
      const hit = hitAt(event)
      if (!hit) {
        if (dragging.current) terrain.pauseActiveStroke()
        if (!dragging.current) editor.hideCursor()
        return
      }
      editor.setCursor(hit.point, hit.normal, hit.sectionId)
      if (dragging.current) {
        terrain.continueStroke(hit.point, hit.normal, {
          direction: raycaster.ray.direction,
        })
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      const snapshot = editor.getSnapshot()
      if (snapshot.uiViewMode === 'clean' || snapshot.dragging) return

      // The 3D cursor is available from every tool, because "put the next thing
      // here" is not itself a mode. Right-click is free: the context menu is
      // already suppressed over the viewport.
      if (event.button === 2) {
        if (placeWorldCursor(event)) event.preventDefault()
        return
      }

      if (
        snapshot.cameraMode === 'fly' ||
        event.button !== 0 ||
        event.altKey ||
        !event.isPrimary ||
        dragging.current ||
        activePointerId.current !== null
      ) {
        return
      }

      if (snapshot.tool === 'camera') return

      // The forest tool draws and drags spline nodes, and does it from its own
      // capture-phase listener so a drag on a node never reaches the sculpt
      // path below. Falling through to that path is what would otherwise
      // happen: an unrecognised tool becomes a terrain stroke.
      if (snapshot.tool === 'forest') return

      if (snapshot.tool === 'cursor') {
        placeWorldCursor(event)
        return
      }

      if (snapshot.tool === 'select') {
        castFrom(event)
        const picked = pickAt()
        const hit = backend.raycast(raycaster)
        if (hit) editor.setCursor(hit.point, hit.normal, hit.sectionId)
        // The terrain backend reports a point, not a distance, so the
        // comparison is made along the ray. Half a metre of slack: a rock and
        // the ground it is planted in meet almost exactly, and an ordering
        // decided by float noise would make planted rocks unselectable.
        const groundDistance = hit
          ? raycaster.ray.origin.distanceTo(hit.point)
          : Infinity
        if (picked && picked.distance <= groundDistance + 0.5) {
          editor.select(
            picked.target.kind,
            picked.target.id,
            `${nameOf(picked.target)} selected`,
          )
          return
        }
        if (
          snapshot.selectedRockId ||
          snapshot.selectedLightId ||
          snapshot.selectedModifierId
        ) {
          editor.patch({
            selectedRockId: undefined,
            selectedLightId: undefined,
            selectedModifierId: undefined,
            status: 'Selection cleared',
          })
        }
        return
      }

      const hit = hitAt(event)
      if (!hit) return
      editor.setCursor(hit.point, hit.normal, hit.sectionId)
      event.preventDefault()
      event.stopPropagation()
      dragging.current = true
      dragKind.current = snapshot.tool === 'water' ? 'water' : 'terrain'
      activePointerId.current = event.pointerId
      editor.patch({ dragging: true })
      canvas.setPointerCapture(event.pointerId)
      if (dragKind.current === 'water') {
        if (snapshot.waterMode === 'add') primeWaterLevel(event)
        paintWater(event)
        return
      }
      const modifierId = terrain.beginStroke(hit.point, hit.normal, snapshot, {
        direction: raycaster.ray.direction,
      })
      if (modifierId) {
        editor.patch({
          selectedModifierId: modifierId,
          selectedRockId: undefined,
          selectedLightId: undefined,
        })
      }
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
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (dragKind.current === 'water') {
        const mode = editor.getSnapshot().waterMode
        editor.patch({
          dragging: false,
          status: mode === 'add' ? 'Water added' : 'Water removed',
        })
        return
      }
      const result = terrain.endStroke()
      const tool = editor.getSnapshot().tool
      editor.patch({
        dragging: false,
        status:
          result === 'cancelled'
            ? 'Tunnel cancelled · drag between two distinct surface portals'
            : tool === 'dig'
              ? 'Cave carve joined and queued for background compile'
              : 'Edit queued for background compile',
      })
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
      if (hoverHandle !== undefined) cancelAnimationFrame(hoverHandle)
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
  }, [backend, camera, editor, gl.domElement, pointer, raycaster, scene, terrain])

  useEffect(() => {
    if (cameraMode === 'fly') editor.hideCursor()
  }, [cameraMode, editor])

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
      <WorldCursorMarker editor={editor} />
    </>
  )
}

function preventContextMenu(event: Event): void {
  event.preventDefault()
}
