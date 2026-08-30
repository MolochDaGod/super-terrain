import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { Euler, MathUtils, Plane, Vector2, Vector3 } from 'three/webgpu'
import type { Object3D } from 'three/webgpu'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { WorldTerrain } from '../terrain/WorldTerrain'
import type { EditorStore } from '../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../terrain/react/hooks'
import { TerrainEnvironment } from '../terrain/react/TerrainEnvironment'
import { TerrainRenderPipeline } from '../terrain/react/TerrainRenderPipeline'
import { FoliageLayer } from '../foliage/react/FoliageLayer'
import { forestFloorRecipe } from './forestFloors'
import { ForestFloorProps } from './ForestFloorProps'
import type { FoliageEditorStore } from '../foliage/FoliageEditorStore'
import { TreeAssetView } from './TreeAssetView'
import {
  DistanceLodForest,
  ForestMaterialPreloader,
  PrototypeCompiler,
} from './ForestRenderer'
import { TreeMaterialPrewarmer } from './materials/TreeMaterialPrewarmer'
import {
  selectedTreePlacement,
  selectedTreePrototype,
  type TreeEditorStore,
} from './TreeEditorStore'
import { useTreeEditorSnapshot } from './useTreeEditorSnapshot'
import { gpuRetirementBacklog } from '../terrain/rendering/gpuResourceRetirement'
import { invalidateTerrainShadows } from '../terrain/rendering/environment/terrainShadowInvalidation'

const FLY_SPEED = 3
const FLY_BOOST_SPEED = 80
/**
 * Geometry compiles stay serialised. Each one saturates a core for about a
 * second and the texture pool already owns the rest of them; running several
 * only moves the same work around while making the first tree appear later.
 */
const MAX_CONCURRENT_TREE_COMPILERS = 1

/**
 * Loaded only when the View menu turns GI on.
 *
 * The rig pulls in the whole tracing package — volume builders, probe kernels,
 * a distance transform. None of that belongs in the editor's startup path for a
 * feature that ships switched off.
 */
const ForestGi = lazy(async () => ({
  default: (await import('./gi/ForestGi')).ForestGi,
}))

/** Forest authoring scene: prototypes compile once and placements render in batches. */
export function TreeScene({
  editor,
  store,
  foliage,
  terrain,
}: {
  editor: EditorStore
  store: TreeEditorStore
  foliage: FoliageEditorStore
  terrain: WorldTerrain
}) {
  const snapshot = useTreeEditorSnapshot(store)
  const raycaster = useThree((state) => state.raycaster)
  const [warmupObject, setWarmupObject] = useState<
    ((object: Object3D) => Promise<void>) | undefined
  >(undefined)
  const publishWarmup = useCallback(
    (warm: (object: Object3D) => Promise<void>) => setWarmupObject(() => warm),
    [],
  )
  const prototypes = Object.values(snapshot.prototypes)
  const activeCompilers = prototypes.filter((prototype) => prototype.building)
  const queuedCompilers = prototypes
    .filter((prototype) =>
      !prototype.building && prototype.compiledRevision !== prototype.buildRevision,
    )
    .slice(0, Math.max(0, MAX_CONCURRENT_TREE_COMPILERS - activeCompilers.length))
  const compilingPrototypes = [...activeCompilers, ...queuedCompilers]
  const selectedPlacement = selectedTreePlacement(snapshot)
  const selectedPrototype = selectedTreePrototype(snapshot)
  const targetY = selectedPrototype ? selectedPrototype.parameters.height * 0.3 : 8

  useEffect(() => {
    const previous = raycaster.firstHitOnly
    raycaster.firstHitOnly = true
    return () => { raycaster.firstHitOnly = previous }
  }, [raycaster])

  const reportGiStatus = useCallback(
    (giStatus: string) => store.patch({ giStatus }),
    [store],
  )

  // Shadow maps are only re-rendered when something says the scene changed, and
  // the only thing that said so was the terrain backend and camera motion. A
  // stand compiles one prototype at a time over tens of seconds, so trees that
  // appeared after the last camera move cast no shadow at all until the view
  // was nudged — which is exactly how it looked: a forest standing in light it
  // was not blocking.
  const shadowCasters = `${snapshot.placements.length}:${snapshot.rocks.length}:${snapshot.lod}:${snapshot.showFoliage}:` +
    prototypes.map((prototype) => `${prototype.id}@${prototype.compiledRevision ?? -1}`).join(',')
  useEffect(() => {
    invalidateTerrainShadows()
  }, [shadowCasters])

  return (
    <>
      <TerrainEnvironment
        mode="full"
        config={terrain.config}
        look="forest"
        updatePriority={0}
      />
      <FoliageLayer
        store={foliage}
        recipe={forestFloorRecipe(snapshot.forestPreset)}
        warmup={warmupObject}
      />
      <TreeMaterialPrewarmer warmup={warmupObject} />

      <ForestFloorProps
        placements={snapshot.placements}
        prototypes={snapshot.prototypes}
        rocks={snapshot.rocks}
      />

      <ForestMaterialPreloader prototypes={prototypes} />

      {compilingPrototypes.map((prototype) => (
        <PrototypeCompiler key={prototype.id} prototype={prototype} store={store} />
      ))}

      {prototypes.map((prototype) => {
        if (!prototype.asset) return null
        const placements = snapshot.placements.filter(
          (placement) => placement.prototypeId === prototype.id,
        )
        if (placements.length === 0) return null
        const asset = prototype.asset
        const revision = prototype.compiledRevision ?? 0
        // Deadfall renders from the same compiled asset as the stems it fell
        // from — one prototype, one bake, one set of pipelines — but without
        // its canopy: a log that has been on the floor long enough to grow
        // moss has not kept its leaves.
        const standing = placements.filter((placement) => !placement.tilt)
        const fallen = placements.filter((placement) => placement.tilt)
        return (
          <Fragment key={`${prototype.id}:${revision}`}>
            {standing.length > 0 && (
              <DistanceLodForest
                asset={asset}
                instances={standing}
                lodBias={snapshot.lod}
                showFoliage={snapshot.showFoliage}
                selectedId={snapshot.selectedPlacementId}
                warmup={warmupObject}
              />
            )}
            {fallen.length > 0 && (
              <DistanceLodForest
                asset={asset}
                instances={fallen}
                lodBias={snapshot.lod}
                showFoliage={false}
                selectedId={snapshot.selectedPlacementId}
                warmup={warmupObject}
              />
            )}
          </Fragment>
        )
      })}

      {snapshot.debugMode !== 'surface' && selectedPrototype?.asset && selectedPlacement && (
        <group
          position={selectedPlacement.position}
          rotation={[0, selectedPlacement.rotation, 0]}
          scale={selectedPlacement.scale}
        >
          <TreeAssetView
            asset={selectedPrototype.asset}
            lodLevel={snapshot.lod}
            debugMode={snapshot.debugMode}
            showFoliage={false}
            resolution="forest"
          />
        </group>
      )}

      {snapshot.gi && (
        <Suspense fallback={null}>
          <ForestGi store={store} onStatus={reportGiStatus} />
        </Suspense>
      )}

      <ForestPointerController store={store} />
      <TreeCamera editor={editor} targetY={targetY} />
      <TreeDevHandle store={store} />
      <TerrainRenderPipeline
        mode="full"
        look="tree"
        onWarmupReady={publishWarmup}
      />
    </>
  )
}

/**
 * Selection is deliberately outside R3F's event manager. Interactive meshes
 * are otherwise raycast for every pointer move, including every orbit frame.
 * A stationary gesture performs two explicit BVH queries at pointer-up and is
 * accepted only when both endpoints hit the same tree.
 */
function ForestPointerController({ store }: { store: TreeEditorStore }) {
  const canvas = useThree((state) => state.gl.domElement)
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)
  const raycaster = useThree((state) => state.raycaster)
  const pointer = useRef(new Vector2())
  const ground = useRef(new Plane(new Vector3(0, 1, 0), 0))
  const groundHit = useRef(new Vector3())

  useEffect(() => {
    let gesture: {
      pointerId: number
      x: number
      y: number
      camera: readonly number[]
    } | undefined

    const setRay = (x: number, y: number) => {
      const bounds = canvas.getBoundingClientRect()
      pointer.current.set(
        ((x - bounds.left) / bounds.width) * 2 - 1,
        -((y - bounds.top) / bounds.height) * 2 + 1,
      )
      raycaster.setFromCamera(pointer.current, camera)
    }

    const treeAt = (x: number, y: number): string | undefined => {
      setRay(x, y)
      const targets: Object3D[] = []
      scene.traverse((object) => {
        if (object.name === 'forest-selection-volumes') targets.push(object)
      })
      const hit = raycaster.intersectObjects(targets, false)[0]
      if (!hit || hit.instanceId === undefined) return undefined
      const ids = hit.object.userData.treeInstanceIds as string[] | undefined
      return ids?.[hit.instanceId]
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      gesture = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        camera: [
          camera.position.x,
          camera.position.y,
          camera.position.z,
          camera.quaternion.x,
          camera.quaternion.y,
          camera.quaternion.z,
          camera.quaternion.w,
        ],
      }
    }
    const onPointerUp = (event: PointerEvent) => {
      const start = gesture
      gesture = undefined
      if (!start || event.pointerId !== start.pointerId || event.button !== 0) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      const currentCamera = [
        camera.position.x,
        camera.position.y,
        camera.position.z,
        camera.quaternion.x,
        camera.quaternion.y,
        camera.quaternion.z,
        camera.quaternion.w,
      ]
      const cameraMoved = currentCamera.some(
        (value, index) => Math.abs(value - start.camera[index]!) > 1e-7,
      )
      // Even a sub-pixel camera drag is navigation, not a click.
      if (cameraMoved || dx * dx + dy * dy > 4) return

      const downTree = treeAt(start.x, start.y)
      const upTree = treeAt(event.clientX, event.clientY)
      if (downTree && downTree === upTree) {
        store.selectPlacement(downTree)
        return
      }
      // Crossing a tree boundary is never a click on either side.
      if (downTree || upTree) return

      const snapshot = store.getSnapshot()
      if (snapshot.armedPrototypeId) {
        setRay(event.clientX, event.clientY)
        const point = raycaster.ray.intersectPlane(ground.current, groundHit.current)
        if (point) store.placeArmed([point.x, 0, point.z])
      } else if (snapshot.selectedPlacementId) {
        store.selectPlacement(undefined)
      }
    }
    const cancelGesture = () => { gesture = undefined }

    canvas.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', cancelGesture)
    window.addEventListener('blur', cancelGesture)
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', cancelGesture)
      window.removeEventListener('blur', cancelGesture)
    }
  }, [camera, canvas, raycaster, scene, store])
  return null
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

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    const handle = globals.__meshtree as Record<string, unknown> | undefined
    if (handle) handle.controls = controls.current
  })

  useLayoutEffect(() => {
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
      controller.target.copy(camera.position).addScaledVector(forward.current, orbitDistance.current)
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
      ) return
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
      next.x = MathUtils.clamp(next.x - event.movementY * 0.0018, -Math.PI * 0.495, Math.PI * 0.495)
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
    if (keys.current.has('KeyQ') || keys.current.has('ControlLeft') || keys.current.has('ControlRight')) {
      movement.current.y -= 1
    }
    if (movement.current.lengthSq() === 0) return
    const boosted = keys.current.has('ShiftLeft') || keys.current.has('ShiftRight')
    movement.current.normalize().multiplyScalar(
      (boosted ? FLY_BOOST_SPEED : FLY_SPEED) * Math.min(delta, 0.1),
    )
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
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space',
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
])

function TreeDevHandle({ store }: { store: TreeEditorStore }) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    globals.__meshtree = { store, gl, scene, camera, gpuRetirementBacklog }
    return () => { delete globals.__meshtree }
  }, [camera, gl, scene, store])
  return null
}
