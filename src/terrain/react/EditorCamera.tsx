import { useEffect, useLayoutEffect, useRef } from 'react'
import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { Euler, MathUtils, MOUSE, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import { useEditorSnapshot } from './hooks'
import { currentViewUrlState } from './viewUrlState'

const DISABLED_MOUSE_ACTION = -1 as (typeof MOUSE)[keyof typeof MOUSE]

interface EditorCameraProps {
  terrain: WorldTerrain
  editor: EditorStore
}

export function EditorCamera({ terrain, editor }: EditorCameraProps) {
  const controls = useRef<OrbitControlsImpl>(null)
  const camera = useThree((state) => state.camera)
  const canvas = useThree((state) => state.gl.domElement)
  const { cameraMode, dragging } = useEditorSnapshot(editor)
  const keys = useRef(new Set<string>())
  const forward = useRef(new Vector3())
  const right = useRef(new Vector3())
  const movement = useRef(new Vector3())
  const flyFocus = useRef(new Vector3())
  const flyRotation = useRef(new Euler(0, 0, 0, 'YXZ'))
  const orbitDistance = useRef(360)
  const urlView = useRef(currentViewUrlState())
  const hasFlown = useRef(false)
  const pointerLocked = useRef(false)

  // TerrainView's frame callback is registered before this component's. Seed
  // the orbit focus during layout so the very first streaming pass cannot
  // center hundreds of jobs on the camera and cancel them one frame later.
  useLayoutEffect(() => {
    const controller = controls.current
    if (!controller) return
    // The declarative target — the URL's, or the default viewpoint's — is the
    // authority on mount. Applying it here rather than waiting for the controls'
    // own first update closes a race against the effect below.
    const target = urlView.current.target
    if (target) {
      controller.target.set(target[0], target[1], target[2])
      controller.update()
    }
    terrain.setViewTarget(controller.target)
  }, [terrain])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      keys.current.add(event.code)
      if (
        editor.getSnapshot().cameraMode === 'fly' &&
        document.pointerLockElement === canvas &&
        FLY_KEYS.has(event.code)
      ) {
        event.preventDefault()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => keys.current.delete(event.code)
    const onBlur = () => keys.current.clear()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [canvas, editor])

  useEffect(() => {
    const controller = controls.current
    if (!controller) return

    if (cameraMode === 'fly') {
      hasFlown.current = true
      orbitDistance.current = Math.max(
        10,
        camera.position.distanceTo(controller.target),
      )
      flyRotation.current.setFromQuaternion(camera.quaternion, 'YXZ')
      controller.enabled = false
      editor.patch({
        cursorVisible: false,
        dragging: false,
        status: 'Fly mode · click the viewport to capture the mouse',
      })
      return
    }

    if (document.pointerLockElement === canvas) document.exitPointerLock()
    if (!hasFlown.current) {
      // Mount, not a return from fly mode. Re-deriving the orbit focus from the
      // camera's current facing is only correct once the camera has been
      // oriented, and on the first frame it has not: R3F starts it looking at
      // the origin, so this would drop the focus at a point 360 m below the
      // viewpoint and leave the editor staring at the ground. The declarative
      // target is already right — keep it.
      controller.enabled = true
      controller.update()
      terrain.setViewTarget(controller.target)
      return
    }
    camera.getWorldDirection(forward.current)
    controller.target
      .copy(camera.position)
      .addScaledVector(forward.current, orbitDistance.current)
    controller.enabled = true
    controller.update()
    terrain.setViewTarget(controller.target)
  }, [camera, cameraMode, canvas, editor, terrain])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        editor.getSnapshot().cameraMode !== 'fly' ||
        document.pointerLockElement === canvas
      ) {
        return
      }
      event.preventDefault()
      const request = canvas.requestPointerLock()
      if (request) {
        void request.catch(() => {
          editor.patch({ status: 'Mouse capture was blocked · click the viewport again' })
        })
      }
    }

    const onPointerLockChange = () => {
      pointerLocked.current = document.pointerLockElement === canvas
      keys.current.clear()
      if (editor.getSnapshot().cameraMode !== 'fly') return
      editor.patch({
        status: pointerLocked.current
          ? 'Fly camera active · WASD move · Shift boost · Esc release'
          : 'Fly mode · click the viewport to capture the mouse',
      })
    }

    const onMouseMove = (event: MouseEvent) => {
      if (
        !pointerLocked.current ||
        editor.getSnapshot().cameraMode !== 'fly'
      ) {
        return
      }
      const rotation = flyRotation.current
      rotation.y -= event.movementX * 0.0018
      rotation.x = MathUtils.clamp(
        rotation.x - event.movementY * 0.0018,
        -Math.PI * 0.495,
        Math.PI * 0.495,
      )
      camera.quaternion.setFromEuler(rotation)
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    document.addEventListener('mousemove', onMouseMove)
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      document.removeEventListener('mousemove', onMouseMove)
      if (document.pointerLockElement === canvas) document.exitPointerLock()
      pointerLocked.current = false
    }
  }, [camera, canvas, editor])

  useFrame((_, delta) => {
    const active = keys.current
    const controller = controls.current
    if (!controller) return

    if (cameraMode === 'fly') {
      controller.enabled = false
      camera.getWorldDirection(forward.current)
      flyFocus.current
        .copy(camera.position)
        .addScaledVector(forward.current, terrain.config.sectionSize * 2.5)
      terrain.setViewTarget(flyFocus.current)
      if (!pointerLocked.current) return

      right.current.crossVectors(forward.current, camera.up).normalize()
      movement.current.set(0, 0, 0)
      if (active.has('KeyW')) movement.current.add(forward.current)
      if (active.has('KeyS')) movement.current.sub(forward.current)
      if (active.has('KeyD')) movement.current.add(right.current)
      if (active.has('KeyA')) movement.current.sub(right.current)
      if (active.has('KeyE') || active.has('Space')) movement.current.y += 1
      if (active.has('KeyQ') || active.has('ControlLeft') || active.has('ControlRight')) {
        movement.current.y -= 1
      }
      if (movement.current.lengthSq() === 0) return
      const speed =
        active.has('ShiftLeft') || active.has('ShiftRight') ? 480 : 120
      movement.current
        .normalize()
        .multiplyScalar(speed * Math.min(delta, 0.1))
      camera.position.add(movement.current)
      return
    }

    const transformDragging = editor.getSnapshot().dragging
    controller.enabled = !transformDragging
    terrain.setViewTarget(controller.target)
    if (transformDragging) {
      controller.mouseButtons.LEFT = DISABLED_MOUSE_ACTION
      controller.mouseButtons.MIDDLE = DISABLED_MOUSE_ACTION
      controller.mouseButtons.RIGHT = DISABLED_MOUSE_ACTION
      return
    }
    const editing = editor.getSnapshot().tool !== 'select'
    const alternateOrbit = active.has('AltLeft') || active.has('AltRight')
    controller.mouseButtons.LEFT =
      !editing || alternateOrbit ? MOUSE.ROTATE : DISABLED_MOUSE_ACTION
    controller.mouseButtons.MIDDLE = MOUSE.DOLLY
    controller.mouseButtons.RIGHT = MOUSE.PAN
    if (terrain.metrics.getSnapshot().activeBenchmark === 'streaming-torture') {
      const phase = performance.now() * 0.0014
      movement.current.set(1, 0, Math.sin(phase) * 0.42)
      movement.current.normalize().multiplyScalar(760 * delta)
      camera.position.add(movement.current)
      controller.target.add(movement.current)
      controller.update()
      return
    }
    if (active.size === 0) return
    camera.getWorldDirection(forward.current)
    forward.current.y = 0
    forward.current.normalize()
    right.current.crossVectors(forward.current, camera.up).normalize()
    movement.current.set(0, 0, 0)
    if (active.has('KeyW')) movement.current.add(forward.current)
    if (active.has('KeyS')) movement.current.sub(forward.current)
    if (active.has('KeyD')) movement.current.add(right.current)
    if (active.has('KeyA')) movement.current.sub(right.current)
    if (active.has('KeyE')) movement.current.y += 1
    if (active.has('KeyQ')) movement.current.y -= 1
    if (movement.current.lengthSq() === 0) return
    const speed = active.has('ShiftLeft') || active.has('ShiftRight') ? 260 : 92
    movement.current.normalize().multiplyScalar(speed * delta)
    camera.position.add(movement.current)
    controller.target.add(movement.current)
    controller.update()
  })

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={cameraMode === 'orbit' && !dragging}
      target={urlView.current.target ?? [340, 105, 245]}
      enableDamping
      dampingFactor={0.075}
      rotateSpeed={0.65}
      zoomSpeed={0.55}
      panSpeed={0.72}
      minDistance={10}
      maxDistance={10_000}
      // A scripted viewpoint must be reproduced exactly. The editor's polar
      // clamp keeps interactive orbiting from rolling under the terrain, but it
      // would silently lift a URL camera that looks up at a peak.
      maxPolarAngle={urlView.current.target ? Math.PI : Math.PI * 0.49}
      screenSpacePanning
      mouseButtons={{
        LEFT: MOUSE.ROTATE,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.PAN,
      }}
    />
  )
}

const FLY_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'Space',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
])
