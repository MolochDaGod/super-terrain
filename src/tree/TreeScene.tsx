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
import {
  TreeAssetView,
  TreeForestAssetView,
  type ForestTreeInstance,
} from './TreeAssetView'
import type { ProceduralTreeAsset, TreeLodLevel, TreeSpecies } from './generator/types'
import { preloadProceduralTreeTextures } from './materials/proceduralTreeTextureClient'
import { treeMaterialSeed } from './materials/proceduralTreeTextures'
import { TreeMaterialPrewarmer } from './materials/TreeMaterialPrewarmer'
import { DEFAULT_TREE_ENVIRONMENT } from './generator/types'
import { generateTreeAsset } from './treeGeneratorClient'
import {
  selectedTreePlacement,
  selectedTreePrototype,
  type TreeEditorStore,
  type TreePrototype,
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

type ForestLodGroups = readonly [
  readonly ForestTreeInstance[],
  readonly ForestTreeInstance[],
  readonly ForestTreeInstance[],
]

/**
 * Keeps instancing while assigning every placement its own distance LOD.
 * Reclassification is throttled and only commits React state when a tree
 * crosses a boundary, so orbiting does not rebuild foliage buffers per frame.
 */
function DistanceLodForest({
  asset,
  instances,
  lodBias,
  showFoliage,
  selectedId,
  warmup,
}: {
  asset: ProceduralTreeAsset
  instances: readonly ForestTreeInstance[]
  lodBias: TreeLodLevel
  showFoliage: boolean
  selectedId?: string
  warmup?: (object: Object3D) => Promise<void>
}) {
  const camera = useThree((state) => state.camera)
  const lastCamera = useRef(new Vector3(Number.POSITIVE_INFINITY, 0, 0))
  const sinceReclassify = useRef(0)
  const groupKey = useRef('')
  // The level each placement was last given. Without it a tree sitting on a
  // boundary re-crosses it on every reclassification, which rebuilds two
  // instance buffers a second for a tree that has not moved.
  const levels = useRef(new Map<string, TreeLodLevel>())
  const [groups, setGroups] = useState<ForestLodGroups>(() =>
    classifyForestLods(asset, instances, camera.position, lodBias, selectedId, levels.current),
  )

  const reclassify = useCallback(() => {
    const next = classifyForestLods(
      asset,
      instances,
      camera.position,
      lodBias,
      selectedId,
      levels.current,
    )
    const nextKey = forestLodGroupsKey(next)
    if (nextKey !== groupKey.current) {
      groupKey.current = nextKey
      setGroups((current) => [
        sameForestInstances(current[0], next[0]) ? current[0] : next[0],
        sameForestInstances(current[1], next[1]) ? current[1] : next[1],
        sameForestInstances(current[2], next[2]) ? current[2] : next[2],
      ])
    }
    lastCamera.current.copy(camera.position)
  }, [asset, camera, instances, lodBias, selectedId])

  useEffect(() => {
    groupKey.current = ''
    levels.current.clear()
    reclassify()
  }, [reclassify])

  // Reclassify little and often, while moving, rather than a lot at a stop.
  //
  // This used to wait for the camera to hold still for 160ms and then only act
  // if it had travelled four metres. Both halves worked against it: walking
  // through a stand accumulated every boundary crossing of the whole walk and
  // then applied them in one commit, and it did so on the frame the viewer had
  // just stopped on — which is precisely the frame a hitch is most visible.
  //
  // Two metres of travel, checked at most six times a second and no longer
  // waiting for a stop, spreads the same total work across the walk in
  // portions small enough to disappear into it.
  useFrame((_, delta) => {
    sinceReclassify.current += delta
    if (sinceReclassify.current < 0.16) return
    if (lastCamera.current.distanceToSquared(camera.position) < 4) return
    sinceReclassify.current = 0
    reclassify()
  })

  // Level 0 always owns the picking proxy.
  //
  // It used to be whichever level happened to be non-empty first, which moved
  // as the stand reclassified — and moving it rebuilds an object BVH over
  // every placement of the prototype, on the frame of the swap. The proxy
  // covers all instances wherever it lives, so pinning it to a level that is
  // now always mounted makes it build once.
  return groups.map((group, level) => (
    <TreeForestAssetView
      key={level}
      asset={asset}
      instances={group}
      lodLevel={level as TreeLodLevel}
      showFoliage={showFoliage}
      selectedId={selectedId}
      selectionProxyInstances={level === 0 ? instances : null}
      warmup={warmup}
    />
  ))
}

function sameForestInstances(
  current: readonly ForestTreeInstance[],
  next: readonly ForestTreeInstance[],
): boolean {
  if (current.length !== next.length) return false
  return current.every((tree, index) => {
    const candidate = next[index]
    return candidate !== undefined &&
      tree.id === candidate.id &&
      tree.position[0] === candidate.position[0] &&
      tree.position[1] === candidate.position[1] &&
      tree.position[2] === candidate.position[2] &&
      tree.rotation === candidate.rotation &&
      tree.scale === candidate.scale &&
      tree.tilt === candidate.tilt
  })
}

function forestLodGroupsKey(groups: ForestLodGroups): string {
  return groups.map((group) => group.map((tree) => [
    tree.id,
    tree.position[0],
    tree.position[1],
    tree.position[2],
    tree.rotation,
    tree.scale,
  ].join(':')).join(',')).join('|')
}

/**
 * Fraction of a boundary distance a tree has to travel past it before its
 * level changes back.
 *
 * A pure threshold makes the level a function of a continuous distance, so a
 * placement standing within a metre of a boundary flips every time the camera
 * breathes. Each flip is an instance-buffer rebuild for the whole prototype at
 * both levels, and with a stand's worth of trees strewn along the two
 * boundaries that is a steady drip of rebuilds all the time the viewer is
 * moving. Twelve per cent is about a two-metre band at the near boundary and
 * six at the far one — wide enough that walking pace crosses it in a quarter
 * of a second, narrow enough that nothing is held at the wrong level long
 * enough to see.
 */
const LOD_HYSTERESIS = 0.12

function classifyForestLods(
  asset: ProceduralTreeAsset,
  instances: readonly ForestTreeInstance[],
  camera: Vector3,
  lodBias: TreeLodLevel,
  selectedId?: string,
  previous?: Map<string, TreeLodLevel>,
): ForestLodGroups {
  const groups: [ForestTreeInstance[], ForestTreeInstance[], ForestTreeInstance[]] = [[], [], []]
  const height = asset.parameters.height
  const crown = asset.parameters.crownRadius
  // Distances sized to a stand, not to a landscape.
  //
  // These used to hold LOD 0 out to 55m and LOD 1 out to 180m, which are sane
  // numbers for a tree standing alone on a hillside and useless for a closed
  // forest: a 30m-radius stand fits entirely inside the near band, so every
  // placement classified as LOD 0 and the whole mechanism did nothing but pay
  // for itself. Measured from inside such a stand, that was 537k leaf cards on
  // screen at once.
  //
  // A full-detail crown is only worth its cards while its individual leaves
  // subtend more than a pixel or so, which for these card sizes is closer to a
  // couple of crown radii than to five.
  const nearDistance = MathUtils.clamp(height * 0.32 + crown * 1.15, 9, 21)
  const farDistance = MathUtils.clamp(height * 1.0 + crown * 2.4, 26, 62)

  for (const instance of instances) {
    let level: TreeLodLevel
    if (instance.id === selectedId) {
      level = 0
    } else {
      const dx = camera.x - instance.position[0]
      const dy = camera.y - (instance.position[1] + height * instance.scale * 0.45)
      const dz = camera.z - instance.position[2]
      const distanceSquared = dx * dx + dy * dy + dz * dz
      const scaledNear = nearDistance * instance.scale
      const scaledFar = farDistance * instance.scale
      // The boundary a tree has to clear is pushed outward if it is already at
      // the finer level and inward if it is not, so the crossing distance
      // differs by direction and a stationary tree cannot oscillate.
      const held = previous?.get(instance.id)
      const nearEdge = scaledNear * (held !== undefined && held <= 0 ? 1 + LOD_HYSTERESIS : 1)
      const farEdge = scaledFar * (held !== undefined && held <= 1 ? 1 + LOD_HYSTERESIS : 1)
      level = distanceSquared < nearEdge * nearEdge
        ? 0
        : distanceSquared < farEdge * farEdge ? 1 : 2
      level = Math.max(level, lodBias) as TreeLodLevel
    }
    previous?.set(instance.id, level)
    groups[level].push(instance)
  }
  return groups
}

/**
 * Starts every distinct material bake a forest needs the moment its layout
 * exists.
 *
 * Geometry compiles are serialised, and material bakes used to ride along with
 * them: a forest waited for its fourth material until its fourth prototype had
 * finished meshing. The bakes share no state and the pool already spreads each
 * one across cores, so queueing them all up front turns four sequential bakes
 * into one wave. Materials are keyed by bark/foliage profile, so the duplicate
 * species and variations in a preset all collapse onto the same job.
 */
function ForestMaterialPreloader({
  prototypes,
}: {
  prototypes: readonly TreePrototype[]
}) {
  const speciesKey = [...new Set(prototypes.map((prototype) => prototype.species))]
    .sort()
    .join(',')
  useEffect(() => {
    if (speciesKey.length === 0) return
    const abort = new AbortController()
    for (const species of speciesKey.split(',') as TreeSpecies[]) {
      void preloadProceduralTreeTextures(species, treeMaterialSeed(species), {
        resolution: 'forest',
        signal: abort.signal,
      }).catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.error('Forest material preload failed', error)
        }
      })
    }
    return () => abort.abort()
  }, [speciesKey])
  return null
}

function PrototypeCompiler({
  prototype,
  store,
}: {
  prototype: TreePrototype
  store: TreeEditorStore
}) {
  const { id, buildRevision: revision, compiledRevision, parameters } = prototype
  useEffect(() => {
    if (compiledRevision === revision || !store.beginBuild(id, revision)) return
    const abort = new AbortController()
    const materialReady = preloadProceduralTreeTextures(
      parameters.species,
      parameters.seed,
      { resolution: 'forest', signal: abort.signal },
    ).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Tree material preload failed', error)
      }
    })
    const geometryReady = generateTreeAsset(parameters, DEFAULT_TREE_ENVIRONMENT, {
      signal: abort.signal,
      onProgress: (status, amount) => store.reportProgress(id, revision, status, amount),
    })
    void Promise.all([geometryReady, materialReady]).then(
      ([asset]) => store.finishBuild(id, revision, asset),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        store.failBuild(id, revision, error)
      },
    )
    return () => abort.abort()
  }, [compiledRevision, id, parameters, revision, store])
  return null
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
