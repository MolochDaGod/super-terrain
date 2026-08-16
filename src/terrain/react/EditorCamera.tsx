import { useEffect, useRef } from 'react'
import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { MOUSE, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'

const DISABLED_MOUSE_ACTION = -1 as (typeof MOUSE)[keyof typeof MOUSE]

interface EditorCameraProps {
  terrain: WorldTerrain
  editor: EditorStore
}

export function EditorCamera({ terrain, editor }: EditorCameraProps) {
  const controls = useRef<OrbitControlsImpl>(null)
  const camera = useThree((state) => state.camera)
  const keys = useRef(new Set<string>())
  const forward = useRef(new Vector3())
  const right = useRef(new Vector3())
  const movement = useRef(new Vector3())

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keys.current.add(event.code)
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
  }, [])

  useFrame((_, delta) => {
    const active = keys.current
    const controller = controls.current
    if (!controller) return
    terrain.setViewTarget(controller.target)
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
      target={[0, 28, 0]}
      enableDamping
      dampingFactor={0.075}
      rotateSpeed={0.65}
      zoomSpeed={0.55}
      panSpeed={0.72}
      minDistance={10}
      maxDistance={10_000}
      maxPolarAngle={Math.PI * 0.49}
      screenSpacePanning
      mouseButtons={{
        LEFT: MOUSE.ROTATE,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.PAN,
      }}
    />
  )
}
