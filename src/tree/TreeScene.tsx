import { useEffect, useLayoutEffect, useRef } from 'react'
import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { Euler, MathUtils, Vector3 } from 'three/webgpu'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { WorldTerrain } from '../terrain/WorldTerrain'
import type { EditorStore } from '../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../terrain/react/hooks'
import { TerrainEnvironment } from '../terrain/react/TerrainEnvironment'
import { TreeAssetView } from './TreeAssetView'
import type { TreeEditorStore } from './TreeEditorStore'
import { DEFAULT_TREE_ENVIRONMENT } from './generator/types'
import { generateTreeAsset } from './treeGeneratorClient'
import { useTreeEditorSnapshot } from './useTreeEditorSnapshot'

const GROUND_SIZE = 400
const FLY_SPEED = 12
const FLY_BOOST_SPEED = 80

/** The renderer only consumes compiled assets; generation remains worker-owned. */
export function TreeScene({
  editor,
  store,
  terrain,
}: {
  editor: EditorStore
  store: TreeEditorStore
  terrain: WorldTerrain
}) {
  const snapshot = useTreeEditorSnapshot(store)
  useEffect(() => {
    const revision = snapshot.buildRevision
    if (snapshot.compiledRevision === revision) return
    const abort = new AbortController()
    if (!store.beginBuild(revision)) return
    void generateTreeAsset(snapshot.parameters, DEFAULT_TREE_ENVIRONMENT, {
      signal: abort.signal,
      onProgress: (status, amount) => store.reportProgress(revision, status, amount),
    }).then(
      (asset) => store.finishBuild(revision, asset),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        store.failBuild(revision, error)
      },
    )
    return () => abort.abort()
  }, [snapshot.buildRevision, snapshot.compiledRevision, snapshot.parameters, store])

  return (
    <>
      {/* Same physical daylight, sky dome and cascaded shadows the terrain
          editor renders with. A tree judged under a different rig is judged
          against a look the game will never show. */}
      <TerrainEnvironment mode="full" config={terrain.config} updatePriority={0} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[GROUND_SIZE, GROUND_SIZE, 1, 1]} />
        <meshStandardMaterial color={0x5c6437} roughness={0.95} metalness={0} />
      </mesh>
      {snapshot.asset && (
        <TreeAssetView
          asset={snapshot.asset}
          lodLevel={snapshot.lod}
          debugMode={snapshot.debugMode}
          showFoliage={snapshot.showFoliage}
        />
      )}
      <TreeCamera editor={editor} targetY={snapshot.parameters.height * 0.3} />
      <TreeDevHandle store={store} />
    </>
  )
}

function TreeCamera({ editor, targetY }: { editor: EditorStore; targetY: number }) {
  const controls = useRef<OrbitControlsImpl>(null)
  const camera = useThree((state) => state.camera)
  const canvas = useThree((state) => state.gl.domElement)
  const { cameraMode } = useEditorSnapshot(editor)
  const keys = useRef(new Set<string>())
  const pointerLocked = useRef(false)
  const hasFlown = useRef(false)
  const orbitDistance = useRef(48)
  const rotation = useRef(new Euler(0, 0, 0, 'YXZ'))
  const forward = useRef(new Vector3())
  const right = useRef(new Vector3())
  const movement = useRef(new Vector3())

  // The review harness moves the camera directly, but orbit controls re-aim it
  // at their own target on the very next frame — so every close-up came back
  // pointing at the middle of the crown. Publishing the controller lets a
  // capture move the target with the camera.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    const handle = globals.__meshtree as Record<string, unknown> | undefined
    if (handle) handle.controls = controls.current
  })

  useLayoutEffect(() => {
    // The WebGPU canvas resolves asynchronously. On a cold load the controls
    // ref can still be empty during this layout effect, but the camera itself
    // already exists. Aim it explicitly so the first submitted frame cannot
    // inherit Three's default straight-ahead quaternion and miss the asset.
    camera.lookAt(0, targetY, 0)
    camera.updateMatrixWorld()
    const controller = controls.current
    if (!controller) return
    controller.target.set(0, targetY, 0)
    controller.update()
  }, [camera, targetY])

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
      target={[0, targetY, 0]}
      enableDamping
      dampingFactor={0.075}
      rotateSpeed={0.65}
      zoomSpeed={0.6}
      panSpeed={0.72}
      minDistance={4}
      maxDistance={400}
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

/**
 * Publishes the tree workspace on `window.__meshtree` in development. The
 * review harness drives parameters through the store and reads `ready` to know
 * a frame shows the compiled asset rather than the previous build.
 */
function TreeDevHandle({ store }: { store: TreeEditorStore }) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    globals.__meshtree = { store, gl, scene, camera }
    return () => {
      delete globals.__meshtree
    }
  }, [camera, gl, scene, store])
  return null
}
