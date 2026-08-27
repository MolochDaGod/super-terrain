import { useEffect, useMemo, useRef, useState } from 'react'
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
  Euler,
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
  SphereGeometry,
  Vector3,
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
 * Wood is one native instanced draw; foliage and fruit multiply their authored
 * local instance buffers by the placement transforms and remain one draw per
 * geometry/material batch regardless of how many copies are planted.
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

export function TreeForestAssetView(props: TreeForestAssetViewProps) {
  if (props.instances.length === 0) return null
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
  const forestFoliage = useMemo(
    () => multiplyFoliageInstances(lod.foliage, instances),
    [instances, lod.foliage],
  )
  const forestFruits = useMemo(
    () => multiplyFruitInstances(lod.fruits, instances),
    [instances, lod.fruits],
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
        castShadow={lodLevel === 0}
      />
      {selectionProxyInstances !== null && (
        <ForestSelectionInstances
          asset={asset}
          instances={selectionProxyInstances ?? instances}
        />
      )}
      {showFoliage && (
        <>
          <FoliageInstances
            data={forestFoliage}
            lodLevel={lodLevel}
            textures={textures}
            materials={materialLease.materials}
          />
          <FruitInstances
            data={forestFruits}
            lodLevel={lodLevel}
            material={materialLease.materials.fruit}
          />
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
  useEffect(() => {
    const target = mesh.current
    if (!target) return
    const matrix = new Matrix4()
    for (let index = 0; index < instances.length; index += 1) {
      placementMatrix(instances[index]!, matrix)
      target.setMatrixAt(index, matrix)
    }
    target.instanceMatrix.needsUpdate = true
    target.computeBoundingSphere()
  }, [instances])
  return (
    <instancedMesh
      ref={mesh}
      name="forest-instanced-wood"
      args={[geometry, material, instances.length]}
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

function multiplyFoliageInstances(
  source: TreeFoliageData,
  placements: readonly ForestTreeInstance[],
): TreeFoliageData {
  const count = source.count * placements.length
  const matrices = new Float32Array(count * 16)
  const colors = new Float32Array(count * 3)
  const variants = new Uint8Array(count)
  const outer = new Matrix4()
  const local = new Matrix4()
  const combined = new Matrix4()
  for (let placementIndex = 0; placementIndex < placements.length; placementIndex += 1) {
    placementMatrix(placements[placementIndex]!, outer)
    for (let localIndex = 0; localIndex < source.count; localIndex += 1) {
      const targetIndex = placementIndex * source.count + localIndex
      local.fromArray(source.matrices, localIndex * 16)
      combined.multiplyMatrices(outer, local).toArray(matrices, targetIndex * 16)
      colors.set(
        source.colors.subarray(localIndex * 3, localIndex * 3 + 3),
        targetIndex * 3,
      )
      variants[targetIndex] = source.variants[localIndex] ?? 0
    }
  }
  return { ...source, matrices, colors, variants, count }
}

function multiplyFruitInstances(
  source: TreeFruitData,
  placements: readonly ForestTreeInstance[],
): TreeFruitData {
  const count = source.count * placements.length
  const matrices = new Float32Array(count * 16)
  const colors = new Float32Array(count * 3)
  const outer = new Matrix4()
  const local = new Matrix4()
  const combined = new Matrix4()
  for (let placementIndex = 0; placementIndex < placements.length; placementIndex += 1) {
    placementMatrix(placements[placementIndex]!, outer)
    for (let localIndex = 0; localIndex < source.count; localIndex += 1) {
      const targetIndex = placementIndex * source.count + localIndex
      local.fromArray(source.matrices, localIndex * 16)
      combined.multiplyMatrices(outer, local).toArray(matrices, targetIndex * 16)
      colors.set(source.colors.subarray(localIndex * 3, localIndex * 3 + 3), targetIndex * 3)
    }
  }
  return { matrices, colors, count }
}

const PLACEMENT_AXIS = new Vector3(0, 1, 0)
const PLACEMENT_POSITION = new Vector3()
const PLACEMENT_QUATERNION = new Quaternion()
const PLACEMENT_SCALE = new Vector3()
// YXZ: the yaw aims the stem, then the pitch tips it over in that direction.
const PLACEMENT_EULER = new Euler(0, 0, 0, 'YXZ')

function placementMatrix(instance: ForestTreeInstance, target: Matrix4): Matrix4 {
  PLACEMENT_POSITION.fromArray(instance.position)
  if (instance.tilt) {
    PLACEMENT_EULER.set(instance.tilt, instance.rotation, 0)
    PLACEMENT_QUATERNION.setFromEuler(PLACEMENT_EULER)
  } else {
    PLACEMENT_QUATERNION.setFromAxisAngle(PLACEMENT_AXIS, instance.rotation)
  }
  PLACEMENT_SCALE.setScalar(instance.scale)
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
            data={lod.foliage}
            lodLevel={lodLevel}
            textures={textures}
            materials={materialLease.materials}
          />
          <FruitInstances
            data={lod.fruits}
            lodLevel={lodLevel}
            material={materialLease.materials.fruit}
          />
        </>
      )}
    </group>
  )
}

function FruitInstances({
  data,
  lodLevel,
  material,
}: {
  data: TreeFruitData
  lodLevel: TreeLodLevel
  material: MeshStandardNodeMaterial
}) {
  const geometry = useMemo(
    () => createAttributeInstancedGeometry(
      fruitBaseGeometry(), data.matrices, data.colors, data.count,
    ),
    [data.colors, data.count, data.matrices],
  )
  useEffect(
    () => () => disposeAfterGpuSubmission(() => geometry.dispose()),
    [geometry],
  )

  if (data.count === 0) return null
  return (
    <mesh
      key={geometryKey(geometry)}
      name="fruit-clusters"
      geometry={geometry}
      material={material}
      castShadow={lodLevel === 0}
      receiveShadow
      frustumCulled={false}
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

/** One attribute-instanced batch covers every authored atlas spray variant. */
function FoliageInstances({
  data,
  lodLevel,
  textures,
  materials,
}: {
  data: TreeFoliageData
  lodLevel: TreeLodLevel
  textures: ProceduralTreeTextures
  materials: TreeMaterialSet
}) {
  const atlas = data.cardGeometry === 'spray' && textures.leafAtlas
  const batches = useMemo(
    () => atlas ? [] : splitFoliageByVariant(data),
    [atlas, data],
  )
  if (data.count === 0) return null
  if (data.representation === 'clusters') {
    return (
      <FoliageBatch
        key="clusters"
        name="foliage-clusters"
        matrices={data.matrices}
        colors={data.colors}
        count={data.count}
        cardGeometryEnabled={false}
        geometryKind="spray"
        lodLevel={lodLevel}
        material={materials.cluster}
      />
    )
  }
  if (atlas) {
    return (
      <group name="leaf-cards">
        <FoliageAtlasBatch
          name="leaf-cards-atlas"
          matrices={data.matrices}
          colors={data.colors}
          variants={data.variants}
          count={data.count}
          lodLevel={lodLevel}
          material={materials.leafAtlas}
        />
      </group>
    )
  }
  return (
    <group name="leaf-cards">
      {batches.map((batch, variant) =>
        batch.count === 0 ? null : (
          <FoliageBatch
            key={variant}
            name={`leaf-cards-${variant}`}
            matrices={batch.matrices}
            colors={batch.colors}
            count={batch.count}
            cardGeometryEnabled
            geometryKind={data.cardGeometry}
            geometryVariant={variant}
            lodLevel={lodLevel}
            material={
              data.cardGeometry === 'frond' ||
                data.cardGeometry === 'fan-frond' ||
                data.cardGeometry === 'rosette'
                ? materials.frond
                : materials.leafAtlas
            }
          />
        ),
      )}
    </group>
  )
}

function FoliageAtlasBatch({
  name,
  matrices,
  colors,
  variants,
  count,
  lodLevel,
  material,
}: {
  name: string
  matrices: Float32Array
  colors: Float32Array
  variants: Uint8Array
  count: number
  lodLevel: TreeLodLevel
  material: MeshStandardNodeMaterial
}) {
  const geometry = useMemo(() => {
    const base = foliageBaseGeometry('spray', 0, true)
    return createAttributeInstancedGeometry(base, matrices, colors, count, variants)
  }, [colors, count, matrices, variants])
  useEffect(
    () => () => disposeAfterGpuSubmission(() => geometry.dispose()),
    [geometry],
  )
  return (
    <mesh
      key={geometryKey(geometry)}
      name={name}
      geometry={geometry}
      material={material}
      castShadow={lodLevel === 0}
      receiveShadow
      frustumCulled={false}
    />
  )
}

function FoliageBatch({
  name,
  matrices,
  colors,
  variants,
  count,
  cardGeometryEnabled,
  geometryKind,
  geometryVariant = 0,
  lodLevel,
  material,
}: {
  name: string
  matrices: Float32Array
  colors: Float32Array
  variants?: Uint8Array
  count: number
  cardGeometryEnabled: boolean
  geometryKind: TreeFoliageData['cardGeometry']
  geometryVariant?: number
  lodLevel: TreeLodLevel
  material: MeshStandardNodeMaterial
}) {
  const geometry = useMemo(
    () => {
      const base = foliageBaseGeometry(
        geometryKind, geometryVariant, cardGeometryEnabled,
      )
      return createAttributeInstancedGeometry(base, matrices, colors, count, variants)
    },
    [cardGeometryEnabled, colors, count, geometryKind, geometryVariant, matrices, variants],
  )

  useEffect(
    () => () => disposeAfterGpuSubmission(() => geometry.dispose()),
    [geometry],
  )

  return (
    <mesh
      key={geometryKey(geometry)}
      name={name}
      geometry={geometry}
      material={material}
      castShadow={lodLevel === 0}
      receiveShadow
      frustumCulled={false}
    />
  )
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

function createAttributeInstancedGeometry(
  base: BufferGeometry,
  matrices: Float32Array,
  colors: Float32Array,
  count: number,
  variants?: Uint8Array,
): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  // WebGPURenderer treats BufferGeometry disposal as ownership of every bound
  // attribute. Sharing the cached base attributes between LOD batches means
  // disposing one batch destroys GPU buffers still used by all the others.
  // Each render batch therefore owns a small clone of its base vertex data;
  // the large per-card transform payload remains instanced and is not copied.
  geometry.setIndex(base.getIndex()?.clone() ?? null)
  for (const name of Object.keys(base.attributes)) {
    geometry.setAttribute(name, base.getAttribute(name).clone())
  }
  const matrixBuffer = new InstancedInterleavedBuffer(matrices, 16, 1)
  for (let column = 0; column < 4; column += 1) {
    geometry.setAttribute(
      `treeInstanceMatrix${column}`,
      new InterleavedBufferAttribute(matrixBuffer, 4, column * 4),
    )
  }
  geometry.setAttribute(
    'treeInstanceColor',
    new InstancedBufferAttribute(colors, 3),
  )
  if (variants) {
    geometry.setAttribute(
      'leafVariant',
      new InstancedBufferAttribute(Float32Array.from(variants), 1),
    )
  }
  geometry.instanceCount = count
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
