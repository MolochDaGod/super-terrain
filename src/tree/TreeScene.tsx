import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { Color, Euler, GridHelper, MathUtils, Vector3 } from 'three/webgpu'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { EditorStore } from '../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../terrain/react/hooks'

const GRID_SIZE = 2_000
const GRID_DIVISIONS = 100
const FLY_SPEED = 24
const FLY_BOOST_SPEED = 140

/** A blank tree-authoring viewport: only a ground reference and camera controls. */
export function TreeScene({ editor }: { editor: EditorStore }) {
  const grid = useMemo(
    () =>
      new GridHelper(
        GRID_SIZE,
        GRID_DIVISIONS,
        new Color('#547c70'),
        new Color('#1a2b27'),
      ),
    [],
  )

  useEffect(
    () => () => {
      grid.geometry.dispose()
      if (Array.isArray(grid.material)) {
        grid.material.forEach((material) => material.dispose())
      } else {
        grid.material.dispose()
      }
    },
    [grid],
  )

  return (
    <>
      <color attach="background" args={['#080e0d']} />
      <fog attach="fog" args={['#080e0d', 500, 1_450]} />
      <primitive object={grid} />
      <TreeCamera editor={editor} />
    </>
  )
}

function TreeCamera({ editor }: { editor: EditorStore }) {
  const controls = useRef<OrbitControlsImpl>(null)
  const camera = useThree((state) => state.camera)
  const canvas = useThree((state) => state.gl.domElement)
  const { cameraMode } = useEditorSnapshot(editor)
  const keys = useRef(new Set<string>())
  const pointerLocked = useRef(false)
  const hasFlown = useRef(false)
  const orbitDistance = useRef(180)
  const rotation = useRef(new Euler(0, 0, 0, 'YXZ'))
  const forward = useRef(new Vector3())
  const right = useRef(new Vector3())
  const movement = useRef(new Vector3())

  useLayoutEffect(() => {
    const controller = controls.current
    if (!controller) return
    controller.target.set(0, 0, 0)
    controller.update()
  }, [])

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
    const focusCanvas = (event: PointerEvent) => {
      if (event.composedPath().includes(canvas)) canvas.focus({ preventScroll: true })
    }
    const previousTabIndex = canvas.getAttribute('tabindex')
    canvas.tabIndex = 0
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pointerdown', focusCanvas, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerdown', focusCanvas, true)
      if (previousTabIndex === null) canvas.removeAttribute('tabindex')
      else canvas.setAttribute('tabindex', previousTabIndex)
    }
  }, [canvas, editor])

  useEffect(() => {
    const controller = controls.current
    if (!controller) return
    if (cameraMode === 'fly') {
      hasFlown.current = true
      orbitDistance.current = Math.max(10, camera.position.distanceTo(controller.target))
      rotation.current.setFromQuaternion(camera.quaternion, 'YXZ')
      controller.enabled = false
      return
    }

    if (document.pointerLockElement === canvas) document.exitPointerLock()
    if (hasFlown.current) {
      camera.getWorldDirection(forward.current)
      controller.target
        .copy(camera.position)
        .addScaledVector(forward.current, orbitDistance.current)
    }
    controller.enabled = true
    controller.update()
  }, [camera, cameraMode, canvas])

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
      void canvas.requestPointerLock().catch(() => {
        editor.patch({ status: 'Mouse capture was blocked · click the viewport again' })
      })
    }
    const onPointerLockChange = () => {
      pointerLocked.current = document.pointerLockElement === canvas
      keys.current.clear()
    }
    const onMouseMove = (event: MouseEvent) => {
      if (!pointerLocked.current || editor.getSnapshot().cameraMode !== 'fly') return
      const next = rotation.current
      next.y -= event.movementX * 0.0018
      next.x = MathUtils.clamp(
        next.x - event.movementY * 0.0018,
        -Math.PI * 0.495,
        Math.PI * 0.495,
      )
      camera.quaternion.setFromEuler(next)
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
    const controller = controls.current
    if (!controller || cameraMode !== 'fly') return
    controller.enabled = false
    if (!pointerLocked.current) return

    camera.getWorldDirection(forward.current)
    right.current.crossVectors(forward.current, camera.up).normalize()
    movement.current.set(0, 0, 0)
    if (keys.current.has('KeyW')) movement.current.add(forward.current)
    if (keys.current.has('KeyS')) movement.current.sub(forward.current)
    if (keys.current.has('KeyD')) movement.current.add(right.current)
    if (keys.current.has('KeyA')) movement.current.sub(right.current)
    if (keys.current.has('KeyE') || keys.current.has('Space')) movement.current.y += 1
    if (
      keys.current.has('KeyQ') ||
      keys.current.has('ControlLeft') ||
      keys.current.has('ControlRight')
    ) {
      movement.current.y -= 1
    }
    if (movement.current.lengthSq() === 0) return
    const boosted = keys.current.has('ShiftLeft') || keys.current.has('ShiftRight')
    movement.current
      .normalize()
      .multiplyScalar((boosted ? FLY_BOOST_SPEED : FLY_SPEED) * Math.min(delta, 0.1))
    camera.position.add(movement.current)
  })

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      domElement={canvas}
      enabled={cameraMode === 'orbit'}
      target={[0, 0, 0]}
      enableDamping
      dampingFactor={0.075}
      rotateSpeed={0.65}
      zoomSpeed={0.6}
      panSpeed={0.72}
      minDistance={4}
      maxDistance={4_000}
      maxPolarAngle={Math.PI * 0.495}
      screenSpacePanning
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
