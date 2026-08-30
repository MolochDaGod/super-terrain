import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CENTER,
  ObjectBVH,
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh'
import type { BVHOptions } from 'three-mesh-bvh'
import {
  BufferAttribute,
  BufferGeometry,
  Box3,
  Color,
  Euler,
  Frustum,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  LineBasicNodeMaterial,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  Sphere,
  SphereGeometry,
  Vector3,
  type Camera,
  type Object3D,
  type Texture,
} from 'three/webgpu'
import type {
  ProceduralTreeAsset,
  SemanticTreeGraph,
  TreeFoliageData,
  TreeFruitData,
  TreeLodLevel,
  TreeMeshData,
  TreeSpineSample,
  TreeVec3,
} from './generator/types'
import type { TreeDebugMode } from './TreeEditorStore'
import {
  type ProceduralTreeTextures,
  type TreeTextureResolution,
} from './materials/proceduralTreeTextures'
import { bakeProceduralTreeTexturesAsync } from './materials/proceduralTreeTextureClient'
import { createFoliageMaterial, createFrondMaterial } from './materials/leafMaterial'
import { createLeafCardGeometry, splitFoliageByVariant } from './materials/leafCardGeometry'
import { createFrondCardGeometry } from './materials/frondCardGeometry'
import { createPalmFanGeometry } from './materials/palmFanGeometry'
import { createSucculentRosetteGeometry } from './materials/succulentRosetteGeometry'
import { createBarkMaterial } from './materials/bark/material'
import { createFruitMaterial } from './materials/fruitMaterial'
import { retireGpuResource } from '../terrain/rendering/gpuResourceRetirement'

// MeshBVH's extension is intentionally installed once at the tree renderer
// boundary. Geometries without a bounds tree retain Three's stock fallback.
Mesh.prototype.raycast = acceleratedRaycast

function disposeAfterGpuSubmission(dispose: () => void): void {
  retireGpuResource(dispose)
}

/**
 * Which LODs cast into the sun's shadow map.
 *
 * All of them, and the reason is worth recording because it has now been got
 * wrong in both directions.
 *
 * The first version tied casting to the near LOD, so a tree stopped casting
 * the instant it crossed a 21-metre boundary and a stand seen from outside
 * cast nothing at all. The second held it to LOD 1, which fixed the stand but
 * left the boundary — at 26 to 62 metres, right in the middle of everything
 * the viewer is looking at. Walking forward through a wood then pulled whole
 * groups of crowns into the shadow map at once, and the floor a few tens of
 * metres ahead went from unshadowed to dappled in a single frame. That is not
 * a subtle LOD seam; it is the brightest change in the frame, because a
 * canopy's shadow *is* most of the contrast on a forest floor.
 *
 * There is no distance at which switching a caster on or off is invisible, so
 * the switch has to go. What pays for it is the cascade schedule in
 * `createTerrainEnvironment`: the near cascade redraws every frame, the ones
 * behind it redraw every second and third frame. The saving is roughly
 * proportional — three full cascade passes a frame become about 1.8 — and it
 * is spent where it cannot be seen, because a hundred metres away a shadow
 * that is two frames stale has moved by less than a texel.
 *
 * Measured at an eye-level interior station, production, DPR 2, with the
 * camera moving so the cascade maps actually redraw each frame:
 *
 *   wood only, 316 casters        56ms
 *   foliage to LOD 1, 171k        59ms
 *   every LOD casting, 243k       73ms
 *   every LOD casting, staggered  ~62ms
 *
 * Trunks were always free and always worth casting: they carry the long floor
 * shadows that give a stand its depth.
 */
const WOOD_CASTS_SHADOW = true

function foliageCastsShadow(_lodLevel: TreeLodLevel): boolean {
  return true
}

/**
 * An opaque carrier for instance buffers that cross a React prop boundary.
 *
 * React's development build renders a performance track by diffing the props
 * of every fiber it re-renders, descending three levels into any object it
 * finds — and a typed array is just an object with a few million enumerable
 * indices. Handing `Float32Array`s to a component therefore costs time
 * proportional to the number of floats on every update: a forest LOD
 * reclassification spent 14 seconds there. Production strips the instrument
 * entirely, so this is not a rendering cost; it is a development one, and the
 * editor is where the trees are actually looked at.
 *
 * The payload lives behind a non-enumerable property, so the inspector walks
 * this object, finds nothing, and stops.
 */
class BulkInstanceSource<T> {
  declare readonly value: T
  constructor(value: T) {
    Object.defineProperty(this, 'value', { value, enumerable: false })
  }
}

/** Memoises the carrier so a stable payload keeps a stable prop identity. */
function useBulkInstanceSource<T>(value: T): BulkInstanceSource<T> {
  return useMemo(() => new BulkInstanceSource(value), [value])
}

/**
 * Forces a new `Mesh` whenever the geometry behind it changes.
 *
 * Three registers one dispose listener per geometry, and that listener deletes
 * the attributes of whatever geometry its render object points at *now* — not
 * the ones the disposed geometry owned. Swapping `geometry` on a live mesh and
 * disposing the previous geometry afterwards therefore destroys the buffers of
 * the replacement while it is still being drawn, and the backend keeps handing
 * the dead handle back for interleaved attributes, so every subsequent frame
 * fails validation. A geometry-keyed mesh never accumulates that second
 * geometry, which keeps disposal pointed at its own buffers.
 */
function geometryKey(geometry: BufferGeometry): string {
  return `geometry-${geometry.id}`
}

export interface TreeAssetViewProps {
  asset: ProceduralTreeAsset
  lodLevel: TreeLodLevel
  debugMode: TreeDebugMode
  showFoliage: boolean
  /**
   * Hero maps are four times the bake of the forest tier and are worth it for
   * a single tree filling the viewport. Inside a forest they are not: the
   * selected tree is the same size as its neighbours, so asking for them there
   * bought nothing visible and stalled the workspace behind a second complete
   * bake of every map.
   */
  resolution?: TreeTextureResolution
  /** Fires after textures, materials, meshes and instance buffers are committed. */
  onRenderResourcesReady?: () => void
  onRenderResourcesError?: (error: unknown) => void
}

/**
 * The lone placement the single-asset view draws through.
 *
 * The forest and single-tree paths share one instanced pipeline, so the
 * editor's one tree is simply a stand of one sitting at its parent group's
 * origin — no second code path, and no second set of pipelines to warm.
 */
const SINGLE_PLACEMENT: readonly ForestTreeInstance[] = [
  { id: 'single', position: [0, 0, 0], rotation: 0, scale: 1 },
]

export interface ForestTreeInstance {
  id: string
  position: readonly [number, number, number]
  rotation: number
  scale: number
  /** Pitch in radians, applied after the yaw. Deadfall lies near a right angle. */
  tilt?: number
}

export function TreeAssetView({
  asset,
  lodLevel,
  debugMode,
  showFoliage,
  resolution = 'hero',
  onRenderResourcesReady,
  onRenderResourcesError,
}: TreeAssetViewProps) {
  const [textures, setTextures] = useState<ProceduralTreeTextures>()
  const errorHandler = useRef(onRenderResourcesError)
  errorHandler.current = onRenderResourcesError

  useEffect(() => {
    const abort = new AbortController()
    setTextures(undefined)
    void bakeProceduralTreeTexturesAsync(
      asset.parameters.species,
      asset.parameters.seed,
      { signal: abort.signal, resolution },
    ).then(
      (created) => {
        if (abort.signal.aborted) {
          created.dispose()
          return
        }
        setTextures(created)
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        errorHandler.current?.(error)
      },
    )
    return () => abort.abort()
  }, [asset.parameters.seed, asset.parameters.species, resolution])

  useEffect(() => () => {
    if (textures) disposeAfterGpuSubmission(() => textures.dispose())
  }, [textures])

  if (!textures) return null
  return (
    <ReadyTreeAssetView
      asset={asset}
      lodLevel={lodLevel}
      debugMode={debugMode}
      showFoliage={showFoliage}
      textures={textures}
      onRenderResourcesReady={onRenderResourcesReady}
    />
  )
}

/**
 * A complete shared tree prototype rendered across many forest placements.
 * Wood, foliage and fruit remain instanced, split only into conservative
 * spatial chunks so the view and shadow frustums can reject unseen work.
 */
interface TreeForestAssetViewProps {
  asset: ProceduralTreeAsset
  instances: readonly ForestTreeInstance[]
  lodLevel: TreeLodLevel
  showFoliage: boolean
  selectedId?: string
  /** Override the picking batch, or pass null when another LOD owns it. */
  selectionProxyInstances?: readonly ForestTreeInstance[] | null
  warmup?: (object: Object3D) => Promise<void>
}

/**
 * Deliberately renders an empty level rather than unmounting it.
 *
 * A distance reclassification empties one LOD group and fills another. When an
 * empty group unmounted, everything it owned went with it — the material
 * lease, the compiled pipelines, the warm-up — and refilling it later mounted a
 * fresh subtree that had to bake, lease and warm all over again from scratch.
 * That is both halves of what a LOD swap looked like: a stutter while the work
 * was redone, and, because the group hides itself behind `visible={ready}`
 * until its warm-up resolves, every tree in it vanishing for the duration.
 *
 * Keeping the level mounted with zero instances costs three empty draws and
 * makes the swap a buffer update.
 */
export function TreeForestAssetView(props: TreeForestAssetViewProps) {
  return <TexturedTreeForestAssetView {...props} />
}

function TexturedTreeForestAssetView({
  asset,
  instances,
  lodLevel,
  showFoliage,
  selectedId,
  selectionProxyInstances,
  warmup,
}: TreeForestAssetViewProps) {
  const [textures, setTextures] = useState<ProceduralTreeTextures>()
  useEffect(() => {
    const abort = new AbortController()
    void bakeProceduralTreeTexturesAsync(
      asset.parameters.species,
      asset.parameters.seed,
      { signal: abort.signal, resolution: 'forest' },
    ).then((created) => {
      if (abort.signal.aborted) created.dispose()
      else setTextures(created)
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Forest tree textures failed', error)
      }
    })
    return () => abort.abort()
  }, [asset.parameters.seed, asset.parameters.species])
  useEffect(() => () => {
    if (textures) disposeAfterGpuSubmission(() => textures.dispose())
  }, [textures])
  if (!textures) return null
  return (
    <ReadyTreeForestAssetView
      asset={asset}
      instances={instances}
      lodLevel={lodLevel}
      showFoliage={showFoliage}
      selectedId={selectedId}
      selectionProxyInstances={selectionProxyInstances}
      warmup={warmup}
      textures={textures}
    />
  )
}

function ReadyTreeForestAssetView({
  asset,
  instances,
  lodLevel,
  showFoliage,
  selectedId,
  selectionProxyInstances,
  warmup,
  textures,
}: {
  asset: ProceduralTreeAsset
  instances: readonly ForestTreeInstance[]
  lodLevel: TreeLodLevel
  showFoliage: boolean
  selectedId?: string
  selectionProxyInstances?: readonly ForestTreeInstance[] | null
  warmup?: (object: Object3D) => Promise<void>
  textures: ProceduralTreeTextures
}) {
  const group = useRef<Group>(null)
  const [ready, setReady] = useState(false)
  const lod = asset.lods[lodLevel]
  const woodGeometry = useTreeGeometry(lod.wood)
  const materialLease = useMemo(() => acquireTreeMaterials(textures), [textures])
  // The per-tree source, not a composed buffer. Composition now happens
  // block-by-block inside the batch, so a reclassification costs the trees
  // that moved rather than every card in the level. See `syncPersistentBatch`.
  const forestFoliage = useBulkInstanceSource(lod.foliage)
  const forestFruits = useBulkInstanceSource(lod.fruits)
  const renderChunks = useMemo(
    () => forestRenderChunks(instances, asset.parameters.height, asset.parameters.crownRadius),
    [asset.parameters.crownRadius, asset.parameters.height, instances],
  )
  useEffect(
    () => () => disposeAfterGpuSubmission(() => materialLease.release()),
    [materialLease],
  )
  // Deliberately not keyed on the instance buffers.
  //
  // A pipeline is keyed by its material and its vertex layout, and a distance
  // reclassification changes neither: it hands the same batch a longer or
  // shorter transform buffer. Re-warming on every buffer swap meant that
  // walking through a stand hid every tree that crossed a LOD boundary and
  // held it hidden for the whole of a `compileAsync` over hundreds of
  // instances — a forest that blinks out whenever the camera moves, and the
  // reason an eye-level review frame could come back as bare ground.
  useEffect(() => {
    const object = group.current
    setReady(false)
    if (!object || !warmup) {
      setReady(true)
      return
    }
    let cancelled = false
    void warmup(object).then(
      () => {
        if (!cancelled) setReady(true)
      },
      (error: unknown) => {
        if (cancelled) return
        console.error('Forest tree pipeline warm-up failed', error)
        // A failed asynchronous warm-up must not permanently hide the tree.
        // The renderer can still compile it through its normal fallback path.
        setReady(true)
      },
    )
    return () => { cancelled = true }
  }, [materialLease, warmup, woodGeometry])

  return (
    <group
      ref={group}
      name={`forest-prototype-${asset.parameters.species}`}
      visible={ready}
    >
      <ForestWoodInstances
        geometry={woodGeometry}
        material={materialLease.materials.bark}
        instances={instances}
        castShadow={WOOD_CASTS_SHADOW}
      />
      {selectionProxyInstances !== null && (
        <ForestSelectionInstances
          asset={asset}
          instances={selectionProxyInstances ?? instances}
        />
      )}
      {showFoliage && (
        <>
          {renderChunks.map((chunk) => (
            <FoliageInstances
              key={`foliage:${chunk.key}`}
              source={forestFoliage}
              instances={chunk.instances}
              bounds={chunk.bounds}
              lodLevel={lodLevel}
              textures={textures}
              materials={materialLease.materials}
            />
          ))}
          {renderChunks.map((chunk) => (
            <FruitInstances
              key={`fruit:${chunk.key}`}
              source={forestFruits}
              instances={chunk.instances}
              bounds={chunk.bounds}
              lodLevel={lodLevel}
              material={materialLease.materials.fruit}
            />
          ))}
        </>
      )}
      {instances.map((instance) => instance.id === selectedId ? (
        <mesh
          key={instance.id}
          position={instance.position}
          rotation={[-Math.PI / 2, 0, instance.rotation]}
          scale={Math.max(1.25, asset.parameters.trunkRadius * 2.4) * instance.scale}
        >
          <ringGeometry args={[0.72, 1, 48]} />
          <meshBasicMaterial color={0x77e8be} transparent opacity={0.72} depthWrite={false} />
        </mesh>
      ) : null)}
    </group>
  )
}

/**
 * Spatial batches let Three reject whole stands against both the view frustum
 * and each shadow cascade. This changes only submission granularity: every
 * tree keeps the same geometry, material, transform and shadow behaviour.
 *
 * A fixed world grid is a poor partition for prototypes. Each species/LOD has
 * only a sparse subset of the stand, so 36 m cells produced hundreds of one-
 * tree draws; making the cells larger then admitted large amounts of geometry
 * outside the frustum. A balanced spatial partition gives every draw useful
 * occupancy while retaining a tight conservative bound.
 */
const FOREST_CHUNK_CAPACITY = (() => {
  if (typeof location === 'undefined') return 8
  const requested = Number(new URLSearchParams(location.search).get('forestChunkInstances'))
  return Number.isInteger(requested) && requested > 0 ? requested : 8
})()

interface ForestRenderChunk {
  key: string
  instances: readonly ForestTreeInstance[]
  bounds: Sphere
}

function forestRenderChunks(
  instances: readonly ForestTreeInstance[],
  height: number,
  crownRadius: number,
): ForestRenderChunk[] {
  const partitions: ForestTreeInstance[][] = []
  const partition = (candidates: ForestTreeInstance[]): void => {
    if (candidates.length <= FOREST_CHUNK_CAPACITY) {
      partitions.push(candidates)
      return
    }
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minZ = Number.POSITIVE_INFINITY
    let maxZ = Number.NEGATIVE_INFINITY
    for (const instance of candidates) {
      minX = Math.min(minX, instance.position[0])
      maxX = Math.max(maxX, instance.position[0])
      minZ = Math.min(minZ, instance.position[2])
      maxZ = Math.max(maxZ, instance.position[2])
    }
    const axis = maxX - minX >= maxZ - minZ ? 0 : 2
    candidates.sort((left, right) => left.position[axis] - right.position[axis])
    const middle = Math.ceil(candidates.length * 0.5)
    partition(candidates.slice(0, middle))
    partition(candidates.slice(middle))
  }
  partition([...instances])

  return partitions.map((chunkInstances, index) => {
    const box = new Box3().makeEmpty()
    const minimum = new Vector3()
    const maximum = new Vector3()
    for (const instance of chunkInstances) {
      const [x, y, z] = instance.position
      const scaledHeight = height * instance.scale
      const scaledCrown = crownRadius * instance.scale
      if (instance.tilt) {
        const reach = scaledHeight + scaledCrown
        minimum.set(x - reach, y - scaledCrown, z - reach)
        maximum.set(x + reach, y + scaledCrown, z + reach)
      } else {
        // Crown radius plus a generous allowance for authored trunk lean.
        const reach = scaledCrown + scaledHeight * 0.25
        minimum.set(x - reach, y - scaledCrown, z - reach)
        maximum.set(x + reach, y + scaledHeight + scaledCrown, z + reach)
      }
      box.expandByPoint(minimum)
      box.expandByPoint(maximum)
    }
    return {
      key: String(index),
      instances: chunkInstances,
      bounds: box.getBoundingSphere(new Sphere()),
    }
  })
}

function ForestWoodInstances({
  geometry,
  material,
  instances,
  castShadow,
}: {
  geometry: BufferGeometry
  material: MeshStandardNodeMaterial
  instances: readonly ForestTreeInstance[]
  castShadow: boolean
}) {
  const mesh = useRef<InstancedMesh>(null)
  // Allocated in tiers for the same reason the foliage batches are: `args`
  // is reconstruction, so sizing the mesh to the exact instance count rebuilt
  // the InstancedMesh and its GPU buffers on every reclassification.
  const capacity = useTieredCapacity(instances.length)
  useLayoutEffect(() => {
    const target = mesh.current
    if (!target) return
    const matrices = instances.map((instance) => placementMatrix(instance, new Matrix4()))
    const colours = instances.map((instance) => trunkTint(instance, new Color()))
    const localBounds = geometry.boundingSphere?.clone() ?? new Sphere()
    if (!geometry.boundingSphere) geometry.computeBoundingSphere()
    localBounds.copy(geometry.boundingSphere!)
    const projection = new Matrix4()
    const frustum = new Frustum()
    const worldBounds = new Sphere()
    const viewCentre = new Vector3()
    const depths = new Float64Array(matrices.length)
    let activeIndices: number[] = []

    const compactForCamera = (camera: Camera): void => {
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      frustum.setFromProjectionMatrix(
        projection,
        camera.coordinateSystem,
        camera.reversedDepth,
      )
      const visibleIndices: number[] = []
      for (let index = 0; index < matrices.length; index += 1) {
        worldBounds.copy(localBounds).applyMatrix4(matrices[index]!)
        if (!frustum.intersectsSphere(worldBounds)) continue
        viewCentre.copy(worldBounds.center).applyMatrix4(camera.matrixWorldInverse)
        depths[index] = viewCentre.z
        visibleIndices.push(index)
      }
      // Opaque instances are otherwise submitted in layout order. A forest
      // has deep layers of overlapping trunks and branches, so random order
      // defeats early depth rejection and shades the same pixel repeatedly.
      // Camera-space z is negative in front of the view: descending order is
      // nearest first for both perspective views and orthographic cascades.
      visibleIndices.sort((left, right) => depths[right]! - depths[left]!)
      if (
        visibleIndices.length === activeIndices.length &&
        visibleIndices.every((index, slot) => activeIndices[slot] === index)
      ) return
      for (let slot = 0; slot < visibleIndices.length; slot += 1) {
        const source = visibleIndices[slot]!
        target.setMatrixAt(slot, matrices[source]!)
        target.setColorAt(slot, colours[source]!)
      }
      target.count = visibleIndices.length
      target.instanceMatrix.needsUpdate = true
      if (target.instanceColor) target.instanceColor.needsUpdate = true
      activeIndices = visibleIndices
    }

    const previousBeforeRender = target.onBeforeRender
    target.onBeforeRender = (_renderer, _scene, camera) => compactForCamera(camera)
    target.count = 0
    return () => { target.onBeforeRender = previousBeforeRender }
  }, [capacity, geometry, instances])
  return (
    <instancedMesh
      ref={mesh}
      name="forest-instanced-wood"
      args={[geometry, material, capacity]}
      castShadow={castShadow}
      receiveShadow
      frustumCulled={false}
    />
  )
}

function ForestSelectionInstances({
  asset,
  instances,
}: {
  asset: ProceduralTreeAsset
  instances: readonly ForestTreeInstance[]
}) {
  const mesh = useRef<InstancedMesh>(null)
  const geometry = useMemo(() => {
    const created = new SphereGeometry(1, 10, 8)
    computeBoundsTree.call(created, {
      strategy: CENTER,
      targetLeafSize: 4,
      verbose: false,
    })
    return created
  }, [])
  useEffect(() => () => {
    disposeBoundsTree.call(geometry)
    disposeAfterGpuSubmission(() => geometry.dispose())
  }, [geometry])
  useEffect(() => {
    const target = mesh.current
    if (!target) return
    const matrix = new Matrix4()
    const position = new Vector3()
    const scale = new Vector3()
    const rotation = new Quaternion()
    for (let index = 0; index < instances.length; index += 1) {
      const instance = instances[index]!
      position.set(
        instance.position[0],
        instance.position[1] + asset.parameters.height * instance.scale * 0.46,
        instance.position[2],
      )
      rotation.setFromAxisAngle(PLACEMENT_AXIS, instance.rotation)
      scale.set(
        asset.parameters.crownRadius * instance.scale,
        asset.parameters.height * instance.scale * 0.5,
        asset.parameters.crownRadius * instance.scale,
      )
      target.setMatrixAt(index, matrix.compose(position, rotation, scale))
    }
    target.instanceMatrix.needsUpdate = true
    target.computeBoundingSphere()
    target.updateMatrixWorld(true)
    target.userData.treeInstanceIds = instances.map((instance) => instance.id)

    // MeshBVH accelerates the proxy surface; ObjectBVH is the important outer
    // level that prevents InstancedMesh.raycast from walking every planted
    // tree before it can reject distant crowns.
    const objectBvh = new ObjectBVH(target, {
      strategy: CENTER,
      includeInstances: true,
      targetLeafSize: 4,
      precise: false,
      verbose: false,
    } as BVHOptions & { includeInstances: boolean; precise: boolean })
    const defaultRaycast = target.raycast
    target.raycast = (raycaster, intersections) => {
      objectBvh.raycast(raycaster, intersections)
    }
    return () => {
      target.raycast = defaultRaycast
      delete target.userData.treeInstanceIds
    }
  }, [asset.parameters.crownRadius, asset.parameters.height, instances])
  return (
    <instancedMesh
      ref={mesh}
      name="forest-selection-volumes"
      args={[geometry, undefined, instances.length]}
      frustumCulled={false}
    >
      <meshBasicMaterial
        transparent
        opacity={0}
        depthWrite={false}
        colorWrite={false}
      />
    </instancedMesh>
  )
}

/**
 * A deterministic per-trunk tint, multiplied into the bark albedo.
 *
 * Every stem of a species shares one baked bark tile, which is what keeps a
 * forest to one draw call and one bake — and also what made a stand read as a
 * cloned prop: a hundred boles in exactly the same value and exactly the same
 * cast. Real neighbouring trunks differ far more than their bark does, because
 * what varies is not the cork but everything on it. Age, which side the
 * prevailing weather hits, how long the base stays wet, how much algal film has
 * taken — all of it lands as a broad shift in value and a small one in hue.
 *
 * Three multiplies `instanceColor` into the material's colour node for free, so
 * this costs one vec3 per tree and nothing per pixel. The hash is taken from
 * the placement rather than from the draw order, so a tree keeps its tint when
 * the stand is reclassified into different LOD batches around it.
 */
function trunkTint(instance: ForestTreeInstance, target: Color): Color {
  const noise = hashPlacement(instance)
  // Biased downward on purpose. The swing has to be wide enough that
  // neighbouring boles read as different trees, but a stand whose brightest
  // member sits above its own baked albedo is a stand with a cream trunk in
  // it, and one cream trunk pulls the eye harder than every dark one together.
  const value = 0.6 + fract(noise * 71.3) * 0.44
  // Damp trunks green out, dry ones go warm and grey. A quarter of the value
  // swing: bark chroma is low, and matching the two turns a stand into a
  // paint chart.
  const cast = fract(noise * 197.7) - 0.5
  target.setRGB(
    value * (1 + cast * 0.07),
    value * (1 + cast * 0.012),
    value * (1 - cast * 0.085),
  )
  return target
}

function hashPlacement(instance: ForestTreeInstance): number {
  const x = instance.position[0] * 12.9898
  const z = instance.position[2] * 78.233
  return fract(Math.sin(x + z + instance.rotation * 3.771) * 43758.5453)
}

function fract(value: number): number {
  return value - Math.floor(value)
}

const PLACEMENT_AXIS = new Vector3(0, 1, 0)
const PLACEMENT_POSITION = new Vector3()
const PLACEMENT_QUATERNION = new Quaternion()
const PLACEMENT_SCALE = new Vector3()
// YXZ: the yaw aims the stem, then the pitch tips it over in that direction.
const PLACEMENT_EULER = new Euler(0, 0, 0, 'YXZ')

/**
 * Radians of lean given to a standing stem.
 *
 * Small, and it has to stay small. A tree's root flare spreads several metres
 * across the litter, so tipping the whole placement lifts the far side of that
 * flare clear of the ground in proportion to the spread: five degrees on a
 * nine-metre root plate is nearly eighty centimetres of daylight under it.
 * Genuine lean belongs in the geometry, where the generator builds a leaning
 * stem over a level root plate — that is the `Wind shaped` recipe. This is only
 * here to break the dead-plumb uniformity of a stand where every stem shares
 * one prototype.
 */
const PLACEMENT_LEAN = 0.044

/** Fraction by which a crown is stretched on one axis and squeezed on the other. */
const PLACEMENT_CROWN_ASYMMETRY = 0.13

/** Fraction of independent variation in height, separate from girth. */
const PLACEMENT_RISE_VARIANCE = 0.09

const PLACEMENT_LEAN_AXIS = new Vector3()
const PLACEMENT_LEAN_QUATERNION = new Quaternion()

/**
 * A stable pseudo-random value for one placement.
 *
 * Keyed on world position rather than on the instance id so that a tree keeps
 * its own lean and proportions across a regenerate, a reclassification, or a
 * renumbering — anything that would otherwise make the stand visibly reshuffle
 * itself while the camera sits still.
 */
function placementNoise(instance: ForestTreeInstance, salt: number): number {
  const x = Math.imul(Math.round(instance.position[0] * 128) | 0, 0x27d4eb2d)
  const z = Math.imul(Math.round(instance.position[2] * 128) | 0, 0x165667b1)
  let hash = (x ^ z ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d) >>> 0
  return ((hash ^ (hash >>> 13)) >>> 0) / 4294967296
}

function placementMatrix(instance: ForestTreeInstance, target: Matrix4): Matrix4 {
  PLACEMENT_POSITION.fromArray(instance.position)
  if (instance.tilt) {
    PLACEMENT_EULER.set(instance.tilt, instance.rotation, 0)
    PLACEMENT_QUATERNION.setFromEuler(PLACEMENT_EULER)
    PLACEMENT_SCALE.setScalar(instance.scale)
    return target.compose(PLACEMENT_POSITION, PLACEMENT_QUATERNION, PLACEMENT_SCALE)
  }

  // Squared, so most stems are near plumb and a few lean noticeably, rather
  // than every stem leaning by an average amount.
  const bias = placementNoise(instance, 0)
  const lean = bias * bias * PLACEMENT_LEAN
  const heading = placementNoise(instance, 1) * Math.PI * 2
  PLACEMENT_QUATERNION.setFromAxisAngle(PLACEMENT_AXIS, instance.rotation)
  if (lean > 1e-4) {
    PLACEMENT_LEAN_AXIS.set(Math.cos(heading), 0, Math.sin(heading))
    PLACEMENT_LEAN_QUATERNION.setFromAxisAngle(PLACEMENT_LEAN_AXIS, lean)
    // Pre-multiplied: the stem yaws in its own frame and then tips in a world
    // direction, so which way it leans is independent of which way it faces.
    PLACEMENT_QUATERNION.premultiply(PLACEMENT_LEAN_QUATERNION)
    // Settle the butt by the amount the lean lifted it. Cheaper and steadier
    // than solving for the flare, and enough that the base stays in the litter.
    PLACEMENT_POSITION.y -= Math.sin(lean) * instance.scale * 1.6
  }

  // Crowns are not surfaces of revolution. Stretching one horizontal axis and
  // squeezing the other keeps the footprint about the same while making every
  // instance of a prototype a different shape — which is most of what stops a
  // stand reading as one tree stamped two hundred times. The stretch is applied
  // before the yaw, so its axis follows the tree rather than the world.
  const stretch = (placementNoise(instance, 2) - 0.5) * 2 * PLACEMENT_CROWN_ASYMMETRY
  const rise = (placementNoise(instance, 3) - 0.5) * 2 * PLACEMENT_RISE_VARIANCE
  PLACEMENT_SCALE.set(
    instance.scale * (1 + stretch),
    instance.scale * (1 + rise),
    instance.scale * (1 - stretch),
  )
  return target.compose(PLACEMENT_POSITION, PLACEMENT_QUATERNION, PLACEMENT_SCALE)
}

function ReadyTreeAssetView({
  asset,
  lodLevel,
  debugMode,
  showFoliage,
  textures,
  onRenderResourcesReady,
}: TreeAssetViewProps & {
  textures: ProceduralTreeTextures
}) {
  const lod = asset.lods[lodLevel]
  const woodGeometry = useTreeGeometry(lod.wood)
  const singleTreeFoliage = useBulkInstanceSource(lod.foliage)
  const singleTreeFruits = useBulkInstanceSource(lod.fruits)
  const materialLease = useMemo(() => acquireTreeMaterials(textures), [textures])
  const woodMaterial = materialLease.materials.bark
  const surfaceVisible = debugMode === 'surface' || debugMode === 'topology'
  const topologyMaterial = useMemo(
    () =>
      new MeshStandardNodeMaterial({
        color: 0x76e9be,
        wireframe: true,
        transparent: true,
        opacity: 0.78,
        roughness: 0.75,
        depthWrite: true,
      }),
    [],
  )
  const debugGeometry = useMemo(
    () => surfaceVisible
      ? new BufferGeometry()
      : createDebugGeometry(asset.graph, debugMode),
    [asset.graph, debugMode, surfaceVisible],
  )
  const debugMaterial = useMemo(
    () =>
      new LineBasicNodeMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthTest: true,
      }),
    [],
  )
  useEffect(
    () => () => disposeAfterGpuSubmission(() => {
      materialLease.release()
      topologyMaterial.dispose()
      debugMaterial.dispose()
    }),
    [debugMaterial, materialLease, topologyMaterial],
  )
  useEffect(
    () => () => disposeAfterGpuSubmission(() => debugGeometry.dispose()),
    [debugGeometry],
  )
  useEffect(() => {
    let cancelled = false
    // Instance transforms are populated in child passive effects. Publishing
    // in a microtask puts the warm-up after the entire committed effect tree,
    // rather than merely after the worker promise resolves.
    queueMicrotask(() => {
      if (!cancelled) onRenderResourcesReady?.()
    })
    return () => {
      cancelled = true
    }
  }, [
    debugGeometry,
    debugMaterial,
    lod,
    onRenderResourcesReady,
    showFoliage,
    textures,
    topologyMaterial,
    woodGeometry,
    woodMaterial,
  ])

  return (
    <group name="procedural-tree-asset">
      {surfaceVisible && (
        <mesh
          key={geometryKey(woodGeometry)}
          name="adaptive-woody-topology"
          geometry={woodGeometry}
          material={debugMode === 'topology' ? topologyMaterial : woodMaterial}
          castShadow={debugMode === 'surface'}
          receiveShadow
        />
      )}
      {debugMode !== 'surface' && debugMode !== 'topology' && (
        <lineSegments
          key={geometryKey(debugGeometry)}
          geometry={debugGeometry}
          material={debugMaterial}
        />
      )}
      {debugMode === 'contacts' && <ContactMarkers graph={asset.graph} />}
      {showFoliage && debugMode === 'surface' && (
        <>
          <FoliageInstances
            source={singleTreeFoliage}
            instances={SINGLE_PLACEMENT}
            lodLevel={lodLevel}
            textures={textures}
            materials={materialLease.materials}
          />
          <FruitInstances
            source={singleTreeFruits}
            instances={SINGLE_PLACEMENT}
            lodLevel={lodLevel}
            material={materialLease.materials.fruit}
          />
        </>
      )}
    </group>
  )
}

function FruitInstances({
  source,
  instances,
  bounds,
  lodLevel,
  material,
}: {
  source: BulkInstanceSource<TreeFruitData>
  instances: readonly ForestTreeInstance[]
  bounds?: Sphere
  lodLevel: TreeLodLevel
  material: MeshStandardNodeMaterial
}) {
  const data = source.value
  const sourceBatch = useMemo<FoliageSourceBatch>(() => ({
    key: 'fruit',
    name: 'fruit-clusters',
    material,
    geometryKind: 'spray',
    geometryVariant: 0,
    cardGeometryEnabled: false,
    baseGeometry: fruitBaseGeometry(),
    matrices: data.matrices,
    colors: data.colors,
    cardsPerTree: data.count,
  }), [data, material])
  const capacityTrees = useTieredCapacity(instances.length)
  const batch = useMemo(
    () => createPersistentBatch(sourceBatch, capacityTrees),
    [capacityTrees, sourceBatch],
  )
  const geometry = batch.geometry
  useEffect(
    () => () => disposeAfterGpuSubmission(() => geometry.dispose()),
    [geometry],
  )
  useLayoutEffect(() => {
    syncPersistentBatch(batch, instances)
    batch.geometry.boundingSphere = bounds ?? null
  }, [batch, bounds, instances])

  if (data.count === 0) return null
  return (
    <mesh
      key={geometryKey(geometry)}
      name="fruit-clusters"
      geometry={geometry}
      material={material}
      castShadow={foliageCastsShadow(lodLevel)}
      receiveShadow
      frustumCulled={Boolean(bounds)}
    />
  )
}

function useTreeGeometry(mesh: TreeMeshData): BufferGeometry {
  const geometry = useMemo(() => {
    const created = new BufferGeometry()
    created.setAttribute('position', new BufferAttribute(mesh.positions, 3))
    created.setAttribute('normal', new BufferAttribute(mesh.normals, 3))
    created.setAttribute('color', new BufferAttribute(mesh.colors, 3))
    created.setAttribute('uv', new BufferAttribute(mesh.uvs, 2))
    created.setIndex(new BufferAttribute(mesh.indices, 1))
    created.computeBoundingSphere()
    return created
  }, [mesh])
  useEffect(
    () => () => disposeAfterGpuSubmission(() => geometry.dispose()),
    [geometry],
  )
  return geometry
}

/**
 * Every instanced foliage draw a compiled LOD needs, as ready geometry.
 *
 * Built here rather than inside a child component on purpose. React's
 * development build walks the props of every fiber whose props changed, three
 * levels deep, to render its performance track — and it walks a `Float32Array`
 * the same way it walks a plain object, one enumerated index at a time. A
 * forest LOD reclassification hands these components a few million floats, so
 * passing the buffers as props cost 14 seconds of main thread per camera move
 * in `bun dev` while costing production nothing at all. Only geometry crosses
 * a prop boundary now; the bulk data never leaves this module.
 */
/**
 * One instanced draw's worth of *per-tree* foliage: the cards a single
 * placement contributes, before any placement transform is applied.
 *
 * The forest used to compose the whole level on the CPU — every card of every
 * tree in it, multiplied out into a fresh 14MB buffer — and hand that down on
 * each reclassification. It is the same work whether one tree changed level or
 * a hundred did, and concentrated in the frame that noticed, which is what the
 * LOD swap stutter was. Keeping the source per-tree lets a swap write only the
 * blocks that actually moved.
 */
interface FoliageSourceBatch {
  key: string
  name: string
  material: MeshStandardNodeMaterial
  geometryKind: TreeFoliageData['cardGeometry']
  geometryVariant: number
  cardGeometryEnabled: boolean
  /** Overrides the foliage base geometry. Fruit uses a finer icosahedron. */
  baseGeometry?: BufferGeometry
  matrices: Float32Array
  colors: Float32Array
  variants?: Uint8Array
  /** Cards this batch contributes per placement. Constant by construction. */
  cardsPerTree: number
}

function foliageSourceBatches(
  data: TreeFoliageData,
  textures: ProceduralTreeTextures,
  materials: TreeMaterialSet,
): FoliageSourceBatch[] {
  if (data.representation === 'clusters') {
    return [{
      key: 'clusters',
      name: 'foliage-clusters',
      material: materials.cluster,
      geometryKind: 'spray',
      geometryVariant: 0,
      cardGeometryEnabled: false,
      matrices: data.matrices,
      colors: data.colors,
      cardsPerTree: data.count,
    }]
  }
  if (data.cardGeometry === 'spray' && textures.leafAtlas) {
    return [{
      key: 'atlas',
      name: 'leaf-cards-atlas',
      material: materials.leafAtlas,
      geometryKind: 'spray',
      geometryVariant: 0,
      cardGeometryEnabled: true,
      matrices: data.matrices,
      colors: data.colors,
      variants: data.variants,
      cardsPerTree: data.count,
    }]
  }
  const material = data.cardGeometry === 'frond' ||
    data.cardGeometry === 'fan-frond' ||
    data.cardGeometry === 'rosette'
    ? materials.frond
    : materials.leafAtlas
  // Kept even where a variant contributes no cards: the batch set is a
  // property of the compiled asset, and a set that changes with the camera is
  // a set that has to be rebuilt and recompiled when it does.
  return splitFoliageByVariant(data).map((batch, variant) => ({
    key: `variant-${variant}`,
    name: `leaf-cards-${variant}`,
    material,
    geometryKind: data.cardGeometry,
    geometryVariant: variant,
    cardGeometryEnabled: true,
    matrices: batch.matrices,
    colors: batch.colors,
    cardsPerTree: batch.count,
  }))
}

interface PersistentFoliageBatch {
  source: FoliageSourceBatch
  geometry: InstancedBufferGeometry
  matrixBuffer: InstancedInterleavedBuffer
  colorAttribute: InstancedBufferAttribute
  variantAttribute?: InstancedBufferAttribute
  capacityTrees: number
  /** Blocks whose per-card colour and variant have been filled in. */
  filledSlots: number
  /** Placement id at each block, in draw order. */
  order: string[]
  slotOf: Map<string, number>
  /** Placement transform each block was last written with. */
  writtenWith: Map<string, string>
}

/**
 * Rounds a tree count up to a power of two.
 *
 * A GPU buffer cannot be resized, so a batch allocated to exactly the trees it
 * holds must be rebuilt — and recompiled — every time that number changes,
 * which for a forest LOD is every time the camera moves far enough to
 * reclassify one tree. Power-of-two tiers cost at most twice the memory and
 * make almost every reclassification a write into geometry that already
 * exists.
 */
function instanceCapacity(count: number): number {
  if (count <= 0) return 1
  return 2 ** Math.ceil(Math.log2(count))
}

/**
 * A capacity tier that resists oscillation.
 *
 * Sizing straight from `instanceCapacity` means a level hovering either side
 * of a power of two rebuilds its geometry every time it crosses — the single
 * most expensive thing a reclassification can do, and the source of the
 * occasional half-second spike in an otherwise smooth walk. Growing eagerly
 * and shrinking only once the level has dropped below a quarter of what is
 * allocated gives a wide band to wander inside.
 *
 * It does not simply never shrink: the near LOD can hold sixty trees at six
 * thousand cards each, and holding that allocation for every prototype after
 * the viewer has walked out of the stand is tens of megabytes of nothing on a
 * machine that has already been shown to have a ceiling.
 */
function useTieredCapacity(count: number): number {
  const capacity = useRef(1)
  const needed = instanceCapacity(count)
  if (needed > capacity.current || count * 4 < capacity.current) {
    capacity.current = needed
  }
  return capacity.current
}

function placementSignature(instance: ForestTreeInstance): string {
  return `${instance.position[0]},${instance.position[1]},${instance.position[2]},${instance.rotation},${instance.scale},${instance.tilt ?? 0}`
}

/** One attribute-instanced batch covers every authored atlas spray variant. */
function FoliageInstances({
  source,
  instances,
  bounds,
  lodLevel,
  textures,
  materials,
}: {
  source: BulkInstanceSource<TreeFoliageData>
  instances: readonly ForestTreeInstance[]
  bounds?: Sphere
  lodLevel: TreeLodLevel
  textures: ProceduralTreeTextures
  materials: TreeMaterialSet
}) {
  const sources = useMemo(
    () => foliageSourceBatches(source.value, textures, materials),
    [materials, source, textures],
  )
  const capacityTrees = useTieredCapacity(instances.length)
  const batches = useMemo(
    () => sources.map((batch) => createPersistentBatch(batch, capacityTrees)),
    [capacityTrees, sources],
  )
  useEffect(
    () => () => disposeAfterGpuSubmission(() => {
      for (const batch of batches) batch.geometry.dispose()
    }),
    [batches],
  )
  useLayoutEffect(() => {
    for (const batch of batches) {
      syncPersistentBatch(batch, instances)
      batch.geometry.boundingSphere = bounds ?? null
    }
  }, [batches, bounds, instances])
  if (batches.length === 0) return null
  return (
    <group name="leaf-cards">
      {batches.map((batch) => (
        <mesh
          key={geometryKey(batch.geometry)}
          name={batch.source.name}
          geometry={batch.geometry}
          material={batch.source.material}
          castShadow={foliageCastsShadow(lodLevel)}
          receiveShadow
          frustumCulled={Boolean(bounds)}
        />
      ))}
    </group>
  )
}

function createPersistentBatch(
  source: FoliageSourceBatch,
  capacityTrees: number,
): PersistentFoliageBatch {
  const base = source.baseGeometry ?? foliageBaseGeometry(
    source.geometryKind, source.geometryVariant, source.cardGeometryEnabled,
  )
  const geometry = new InstancedBufferGeometry()
  // WebGPURenderer treats BufferGeometry disposal as ownership of every bound
  // attribute. Sharing the cached base attributes between LOD batches means
  // disposing one batch destroys GPU buffers still used by all the others.
  geometry.setIndex(base.getIndex()?.clone() ?? null)
  for (const name of Object.keys(base.attributes)) {
    geometry.setAttribute(name, base.getAttribute(name).clone())
  }
  const cards = capacityTrees * source.cardsPerTree
  const matrixBuffer = new InstancedInterleavedBuffer(
    new Float32Array(Math.max(1, cards) * 16), 16, 1,
  )
  for (let column = 0; column < 4; column += 1) {
    geometry.setAttribute(
      `treeInstanceMatrix${column}`,
      new InterleavedBufferAttribute(matrixBuffer, 4, column * 4),
    )
  }
  // Colour and variant are properties of the card, not of the tree carrying
  // it, so every block holds identical values — but they are filled block by
  // block as the level fills, not tiled across the whole capacity here.
  // Tiling upfront put the entire cost of a tier growth into the one frame
  // that grew, which was the only remaining spike in a walk through the stand.
  const colorAttribute = new InstancedBufferAttribute(
    new Float32Array(Math.max(1, cards) * 3), 3,
  )
  geometry.setAttribute('treeInstanceColor', colorAttribute)
  let variantAttribute: InstancedBufferAttribute | undefined
  if (source.variants) {
    variantAttribute = new InstancedBufferAttribute(new Float32Array(Math.max(1, cards)), 1)
    geometry.setAttribute('leafVariant', variantAttribute)
  }
  geometry.instanceCount = 0
  return {
    source,
    geometry,
    matrixBuffer,
    colorAttribute,
    variantAttribute,
    capacityTrees,
    filledSlots: 0,
    order: [],
    slotOf: new Map(),
    writtenWith: new Map(),
  }
}

/**
 * Copies the per-card colour and variant into a block the first time it is
 * used. Every block holds the same values, so this happens once per slot for
 * the life of the geometry.
 */
function fillSlotConstants(batch: PersistentFoliageBatch, slot: number): void {
  if (slot < batch.filledSlots) return
  const { source } = batch
  for (let index = batch.filledSlots; index <= slot; index += 1) {
    const colors = batch.colorAttribute.array as Float32Array
    colors.set(source.colors, index * source.cardsPerTree * 3)
    batch.colorAttribute.addUpdateRange(
      index * source.cardsPerTree * 3, source.cardsPerTree * 3,
    )
    if (batch.variantAttribute && source.variants) {
      const target = batch.variantAttribute.array as Float32Array
      const offset = index * source.cardsPerTree
      for (let card = 0; card < source.cardsPerTree; card += 1) {
        target[offset + card] = source.variants[card] ?? 0
      }
      batch.variantAttribute.addUpdateRange(offset, source.cardsPerTree)
    }
  }
  batch.colorAttribute.needsUpdate = true
  if (batch.variantAttribute) batch.variantAttribute.needsUpdate = true
  batch.filledSlots = slot + 1
}

const SYNC_OUTER = /*@__PURE__*/ new Matrix4()
const SYNC_LOCAL = /*@__PURE__*/ new Matrix4()
const SYNC_COMBINED = /*@__PURE__*/ new Matrix4()

/**
 * Brings a batch's transforms in line with the placements it now holds,
 * touching only the blocks that changed.
 *
 * Departures are filled by moving the last block down into the hole, which
 * keeps the live blocks contiguous so `instanceCount` alone decides what is
 * drawn. Every write is registered as an update range, so the backend uploads
 * those bytes rather than the whole buffer.
 */
function syncPersistentBatch(
  batch: PersistentFoliageBatch,
  instances: readonly ForestTreeInstance[],
): void {
  const { source, order, slotOf, writtenWith } = batch
  const stride = source.cardsPerTree * 16
  const array = batch.matrixBuffer.array as Float32Array
  let dirty = false
  const touch = (slot: number): void => {
    batch.matrixBuffer.addUpdateRange(slot * stride, stride)
    dirty = true
  }

  if (source.cardsPerTree > 0) {
    const wanted = new Set(instances.map((instance) => instance.id))
    for (let slot = order.length - 1; slot >= 0; slot -= 1) {
      const id = order[slot]!
      if (wanted.has(id)) continue
      const last = order.length - 1
      if (slot !== last) {
        array.copyWithin(slot * stride, last * stride, (last + 1) * stride)
        const moved = order[last]!
        order[slot] = moved
        slotOf.set(moved, slot)
        touch(slot)
      }
      order.pop()
      slotOf.delete(id)
      writtenWith.delete(id)
    }

    for (const instance of instances) {
      const signature = placementSignature(instance)
      let slot = slotOf.get(instance.id)
      if (slot !== undefined && writtenWith.get(instance.id) === signature) continue
      if (slot === undefined) {
        slot = order.length
        order.push(instance.id)
        slotOf.set(instance.id, slot)
      }
      fillSlotConstants(batch, slot)
      placementMatrix(instance, SYNC_OUTER)
      const offset = slot * stride
      for (let card = 0; card < source.cardsPerTree; card += 1) {
        SYNC_LOCAL.fromArray(source.matrices, card * 16)
        SYNC_COMBINED.multiplyMatrices(SYNC_OUTER, SYNC_LOCAL)
          .toArray(array, offset + card * 16)
      }
      writtenWith.set(instance.id, signature)
      touch(slot)
    }
  }

  if (dirty) batch.matrixBuffer.needsUpdate = true
  batch.geometry.instanceCount = order.length * source.cardsPerTree
}

const foliageBaseGeometries = new Map<string, BufferGeometry>()
let cachedFruitBaseGeometry: BufferGeometry | undefined

function fruitBaseGeometry(): BufferGeometry {
  cachedFruitBaseGeometry ??= new IcosahedronGeometry(1, 2)
  return cachedFruitBaseGeometry
}

function foliageBaseGeometry(
  geometryKind: TreeFoliageData['cardGeometry'],
  variant: number,
  cardGeometryEnabled: boolean,
): BufferGeometry {
  const key = cardGeometryEnabled ? `${geometryKind}:${variant}` : 'cluster'
  let geometry = foliageBaseGeometries.get(key)
  if (geometry) return geometry
  geometry = cardGeometryEnabled
    ? geometryKind === 'frond'
      ? createFrondCardGeometry(variant)
      : geometryKind === 'fan-frond'
        ? createPalmFanGeometry(variant)
        : geometryKind === 'rosette'
          ? createSucculentRosetteGeometry(variant)
          : createLeafCardGeometry()
    : new IcosahedronGeometry(1, 1)
  foliageBaseGeometries.set(key, geometry)
  return geometry
}

interface TreeMaterialSet {
  bark: MeshStandardNodeMaterial
  leafAtlas: MeshStandardNodeMaterial
  frond: MeshStandardNodeMaterial
  cluster: MeshStandardNodeMaterial
  fruit: MeshStandardNodeMaterial
}

interface TreeMaterialSetEntry {
  materials: TreeMaterialSet
  references: number
}

const treeMaterialSets = new WeakMap<Texture, TreeMaterialSetEntry>()

function acquireTreeMaterials(textures: ProceduralTreeTextures): {
  materials: TreeMaterialSet
  release(): void
} {
  const key = textures.barkMap
  let entry = treeMaterialSets.get(key)
  if (!entry) {
    entry = {
      materials: {
        bark: createBarkMaterial(textures),
        leafAtlas: createFoliageMaterial(
          textures.leafAtlas ?? textures.leafCards[0],
        ),
        frond: createFrondMaterial(true),
        cluster: createFoliageMaterial(undefined, true),
        fruit: createFruitMaterial(true),
      },
      references: 0,
    }
    treeMaterialSets.set(key, entry)
  }
  entry.references += 1
  let released = false
  return {
    materials: entry.materials,
    release() {
      if (released) return
      released = true
      entry!.references -= 1
      if (entry!.references > 0) return
      treeMaterialSets.delete(key)
      entry!.materials.bark.dispose()
      entry!.materials.leafAtlas.dispose()
      entry!.materials.frond.dispose()
      entry!.materials.cluster.dispose()
      entry!.materials.fruit.dispose()
    },
  }
}

function createDebugGeometry(
  graph: SemanticTreeGraph,
  mode: TreeDebugMode,
): BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const maximumRadius = graph.parts.reduce(
    (maximum, part) => Math.max(maximum, ...part.spine.map((sample) => sample.radius)),
    1,
  )
  for (const [partIndex, part] of graph.parts.entries()) {
    for (let index = 0; index < part.spine.length - 1; index += 1) {
      const a = part.spine[index]!
      const b = part.spine[index + 1]!
      positions.push(
        a.position.x,
        a.position.y,
        a.position.z,
        b.position.x,
        b.position.y,
        b.position.z,
      )
      const colorA = debugColor(mode, part, a, maximumRadius, partIndex)
      const colorB = debugColor(mode, part, b, maximumRadius, partIndex)
      colors.push(colorA.x, colorA.y, colorA.z, colorB.x, colorB.y, colorB.z)
    }
  }
  if (mode === 'contacts') {
    for (const contact of graph.contacts) {
      positions.push(
        contact.locationA.x,
        contact.locationA.y,
        contact.locationA.z,
        contact.locationB.x,
        contact.locationB.y,
        contact.locationB.z,
      )
      colors.push(1, 0.28, 0.12, 1, 0.82, 0.2)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(Float32Array.from(colors), 3))
  return geometry
}

function debugColor(
  mode: TreeDebugMode,
  part: SemanticTreeGraph['parts'][number],
  sample: TreeSpineSample,
  maximumRadius: number,
  index: number,
): TreeVec3 {
  if (mode === 'hierarchy') return hierarchyColor(part.branchOrder, part.type)
  if (mode === 'continuations') {
    return part.junctionType === 'continuation' || part.type === 'trunk'
      ? { x: 0.45, y: 1, z: 0.74 }
      : { x: 0.25, y: 0.38, z: 0.34 }
  }
  if (mode === 'radii') {
    const amount = Math.min(1, sample.radius / maximumRadius)
    return { x: 0.25 + amount * 0.75, y: 0.8 - amount * 0.5, z: 1 - amount * 0.78 }
  }
  if (mode === 'burial') {
    if (part.type !== 'root') return { x: 0.16, y: 0.2, z: 0.18 }
    const exposed = 1 - Math.min(1, sample.burialDepth / Math.max(0.001, sample.crossSection.radiusZ))
    return { x: 0.16 + exposed * 0.84, y: 0.35 + exposed * 0.52, z: 0.9 - exposed * 0.72 }
  }
  if (mode === 'contacts') return { x: 0.2, y: 0.42, z: 0.36 }
  const hue = (index * 0.61803398875) % 1
  return hsvToRgb(hue, 0.56, 0.92)
}

function hierarchyColor(order: number, type: string): TreeVec3 {
  if (type === 'root') return { x: 0.95, y: 0.46, z: 0.18 }
  if (order === 0) return { x: 0.45, y: 0.95, z: 0.72 }
  if (order === 1) return { x: 0.35, y: 0.65, z: 1 }
  return { x: 0.82, y: 0.45, z: 1 }
}

function hsvToRgb(hue: number, saturation: number, value: number): TreeVec3 {
  const sector = hue * 6
  const index = Math.floor(sector)
  const fraction = sector - index
  const p = value * (1 - saturation)
  const q = value * (1 - fraction * saturation)
  const t = value * (1 - (1 - fraction) * saturation)
  const colors: TreeVec3[] = [
    { x: value, y: t, z: p },
    { x: q, y: value, z: p },
    { x: p, y: value, z: t },
    { x: p, y: q, z: value },
    { x: t, y: p, z: value },
    { x: value, y: p, z: q },
  ]
  return colors[index % 6]!
}

function ContactMarkers({ graph }: { graph: SemanticTreeGraph }) {
  return (
    <group name="contact-graph-markers">
      {graph.contacts.map((contact, index) => (
        <mesh
          key={`${contact.partA}-${contact.partB}-${index}`}
          position={[
            (contact.locationA.x + contact.locationB.x) * 0.5,
            (contact.locationA.y + contact.locationB.y) * 0.5,
            (contact.locationA.z + contact.locationB.z) * 0.5,
          ]}
          scale={0.12 + contact.pressure * 0.22}
        >
          <sphereGeometry args={[1, 12, 8]} />
          <meshBasicMaterial color={contact.fusion > 0 ? 0xffd36e : 0xff714e} />
        </mesh>
      ))}
    </group>
  )
}
