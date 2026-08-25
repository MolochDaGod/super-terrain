import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Euler,
  MathUtils,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu'
import type { Group, Object3D } from 'three/webgpu'
import { float, smoothstep, uv } from 'three/tsl'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { WorldTerrain } from '../terrain/WorldTerrain'
import type { EditorStore } from '../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../terrain/react/hooks'
import { TerrainEnvironment } from '../terrain/react/TerrainEnvironment'
import { TerrainRenderPipeline } from '../terrain/react/TerrainRenderPipeline'
import { FoliageLayer } from '../foliage/react/FoliageLayer'
import type { FoliageEditorStore } from '../foliage/FoliageEditorStore'
import { TreeAssetView } from './TreeAssetView'
import { preloadProceduralTreeTextures } from './materials/proceduralTreeTextureClient'
import { TreeMaterialPrewarmer } from './materials/TreeMaterialPrewarmer'
import type { TreeDebugMode, TreeEditorStore } from './TreeEditorStore'
import {
  DEFAULT_TREE_ENVIRONMENT,
  type ProceduralTreeAsset,
  type TreeLodLevel,
} from './generator/types'
import { generateTreeAsset } from './treeGeneratorClient'
import { useTreeEditorSnapshot } from './useTreeEditorSnapshot'

const FLY_SPEED = 12
const FLY_BOOST_SPEED = 80

/** The renderer only consumes compiled assets; generation remains worker-owned. */
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
  const [presented, setPresented] = useState<PreparedTree | null>(null)
  const [prewarmObject, setPrewarmObject] = useState<Group | null>(null)
  const [warmupObject, setWarmupObject] = useState<
    ((object: Object3D) => Promise<void>) | undefined
  >(undefined)
  const publishWarmup = useCallback(
    (warm: (object: Object3D) => Promise<void>) => setWarmupObject(() => warm),
    [],
  )
  useEffect(() => {
    const revision = snapshot.buildRevision
    if (snapshot.compiledRevision === revision) return
    const abort = new AbortController()
    if (!store.beginBuild(revision)) return
    // Material generation is independent of the semantic graph. Starting it
    // beside the geometry worker makes a cold tree pay the slower of the two
    // jobs instead of their sum; TreeAssetView later joins the same cache entry.
    void preloadProceduralTreeTextures(
      snapshot.parameters.species,
      snapshot.parameters.seed,
      { signal: abort.signal },
    ).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Tree material preload failed', error)
      }
    })
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

  // A generated asset is only a candidate until its actual material variants
  // have been compiled against the post pipeline's multisampled scene target.
  // Keep the previous asset mounted and visible while that asynchronous work
  // proceeds; on the first build the stable fallback is simply sky + ground.
  const candidateRevision =
    snapshot.asset && snapshot.compiledRevision === snapshot.buildRevision &&
      snapshot.compiledRevision !== presented?.revision
      ? snapshot.compiledRevision
      : undefined
  const candidateAsset = candidateRevision === undefined ? undefined : snapshot.asset
  const prewarmKey = candidateRevision === undefined
    ? undefined
    : [
        candidateRevision,
        snapshot.lod,
        snapshot.debugMode,
        snapshot.showFoliage ? 1 : 0,
      ].join(':')
  const finishPrewarm = useCallback((key: string) => {
    if (
      candidateRevision === undefined ||
      !candidateAsset ||
      key !== prewarmKey
    ) {
      return
    }
    const current = store.getSnapshot()
    if (
      current.buildRevision !== candidateRevision ||
      current.compiledRevision !== candidateRevision ||
      current.asset !== candidateAsset
    ) {
      return
    }
    setPresented({ revision: candidateRevision, asset: candidateAsset })
    store.finishMaterialWarmup(candidateRevision)
  }, [candidateAsset, candidateRevision, prewarmKey, store])
  const failPrewarm = useCallback((key: string, error: unknown) => {
    if (candidateRevision === undefined || key !== prewarmKey) return
    store.failMaterialWarmup(candidateRevision, error)
  }, [candidateRevision, prewarmKey, store])
  const failRenderResources = useCallback((error: unknown) => {
    if (prewarmKey !== undefined) failPrewarm(prewarmKey, error)
  }, [failPrewarm, prewarmKey])

  const preparedTrees: PreparedTree[] = []
  if (presented) preparedTrees.push(presented)
  if (candidateRevision !== undefined && candidateAsset) {
    preparedTrees.push({ revision: candidateRevision, asset: candidateAsset })
  }

  return (
    <>
      {/* Same physical daylight, sky dome and cascaded shadows the terrain
          editor renders with. A tree judged under a different rig is judged
          against a look the game will never show. */}
      <TerrainEnvironment mode="full" config={terrain.config} updatePriority={0} />
      {/* The soil under the tree is the foliage layer's ground: it carries the
          painted species mask and the far-field canopy, so there is only ever
          one surface at y=0 and nothing to z-fight with. */}
      <FoliageLayer store={foliage} warmup={warmupObject} />
      <TreeMaterialPrewarmer warmup={warmupObject} />
      {preparedTrees.map((entry) => (
        <PreparedTreeView
          key={entry.revision}
          entry={entry}
          active={entry.revision === presented?.revision}
          lodLevel={snapshot.lod}
          debugMode={snapshot.debugMode}
          showFoliage={snapshot.showFoliage}
          prewarmRef={entry.revision === candidateRevision ? setPrewarmObject : undefined}
          onResourceError={
            entry.revision === candidateRevision ? failRenderResources : undefined
          }
        />
      ))}
      <TreeCamera editor={editor} targetY={snapshot.parameters.height * 0.3} />
      <TreeDevHandle store={store} />
      <TerrainRenderPipeline
        mode="full"
        look="tree"
        prewarmObject={candidateRevision === undefined ? null : prewarmObject}
        prewarmKey={prewarmKey}
        onPrewarmComplete={finishPrewarm}
        onPrewarmError={failPrewarm}
        onWarmupReady={publishWarmup}
      />
    </>
  )
}

interface PreparedTree {
  revision: number
  asset: ProceduralTreeAsset
}

function PreparedTreeView({
  entry,
  active,
  lodLevel,
  debugMode,
  showFoliage,
  prewarmRef,
  onResourceError,
}: {
  entry: PreparedTree
  active: boolean
  lodLevel: TreeLodLevel
  debugMode: TreeDebugMode
  showFoliage: boolean
  prewarmRef?: (object: Group | null) => void
  onResourceError?: (error: unknown) => void
}) {
  const stagedObject = useRef<Group>(null)
  const publishForWarmup = useCallback(() => {
    if (stagedObject.current) prewarmRef?.(stagedObject.current)
  }, [prewarmRef])
  useEffect(() => () => prewarmRef?.(null), [prewarmRef])

  return (
    // The outer group keeps the staged asset out of normal scene traversal.
    // compileAsync receives the visible inner group directly, so it still sees
    // every relevant tree and contact-shadow material without ever presenting
    // them to the user before the pipelines are ready.
    <group visible={active}>
      <group ref={stagedObject}>
        <TreeGroundingShadow height={entry.asset.parameters.height} />
        <TreeAssetView
          asset={entry.asset}
          lodLevel={lodLevel}
          debugMode={debugMode}
          showFoliage={showFoliage}
          onRenderResourcesReady={prewarmRef ? publishForWarmup : undefined}
          onRenderResourcesError={onResourceError}
        />
      </group>
    </group>
  )
}

/**
 * Tight, art-directed grounding under the root plate.
 *
 * The sun still supplies the real directional and canopy shadows. This single
 * translucent disc only restores the high-frequency contact term that a wide
 * cascaded shadow map tends to soften away. It is one tiny mesh and one cheap
 * unlit fragment expression, rather than a screen-space AO pass over the frame.
 */
function TreeGroundingShadow({ height }: { height: number }) {
  const radius = Math.max(1.15, height * 0.058)
  return (
    <mesh
      name="root-contact-shadow"
      material={TREE_GROUNDING_SHADOW_MATERIAL}
      position={[0, -0.012, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[radius * 1.45, radius, 1]}
      renderOrder={1}
    >
      <circleGeometry args={[1, 48]} />
    </mesh>
  )
}

const TREE_GROUNDING_SHADOW_MATERIAL = createTreeGroundingShadowMaterial()

function createTreeGroundingShadowMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    name: 'tree root contact shadow',
    color: 0x020302,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  })
  const local = uv().sub(0.5).mul(2)
  const radiusSquared = local.x.mul(local.x).add(local.y.mul(local.y))
  material.opacityNode = smoothstep(1, 0, radiusSquared)
    .pow(1.65)
    .mul(float(0.24))
  return material
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
