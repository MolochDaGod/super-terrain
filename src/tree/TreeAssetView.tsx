import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LineBasicNodeMaterial,
  MeshStandardNodeMaterial,
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
import { type ProceduralTreeTextures } from './materials/proceduralTreeTextures'
import { bakeProceduralTreeTexturesAsync } from './materials/proceduralTreeTextureClient'
import { createFoliageMaterial, createFrondMaterial } from './materials/leafMaterial'
import { createLeafCardGeometry, splitFoliageByVariant } from './materials/leafCardGeometry'
import { createFrondCardGeometry } from './materials/frondCardGeometry'
import { createPalmFanGeometry } from './materials/palmFanGeometry'
import { createSucculentRosetteGeometry } from './materials/succulentRosetteGeometry'
import { createBarkMaterial } from './materials/bark/material'
import { createFruitMaterial } from './materials/fruitMaterial'

export interface TreeAssetViewProps {
  asset: ProceduralTreeAsset
  lodLevel: TreeLodLevel
  debugMode: TreeDebugMode
  showFoliage: boolean
  /** Fires after textures, materials, meshes and instance buffers are committed. */
  onRenderResourcesReady?: () => void
  onRenderResourcesError?: (error: unknown) => void
}

export function TreeAssetView({
  asset,
  lodLevel,
  debugMode,
  showFoliage,
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
      { signal: abort.signal },
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
  }, [asset.parameters.seed, asset.parameters.species])

  useEffect(() => () => textures?.dispose(), [textures])

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
    () => () => {
      materialLease.release()
      topologyMaterial.dispose()
      debugMaterial.dispose()
    },
    [debugMaterial, materialLease, topologyMaterial],
  )
  useEffect(() => () => debugGeometry.dispose(), [debugGeometry])
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
          name="adaptive-woody-topology"
          geometry={woodGeometry}
          material={debugMode === 'topology' ? topologyMaterial : woodMaterial}
          castShadow={debugMode === 'surface'}
          receiveShadow
        />
      )}
      {debugMode !== 'surface' && debugMode !== 'topology' && (
        <lineSegments geometry={debugGeometry} material={debugMaterial} />
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
  useEffect(() => () => geometry.dispose(), [geometry])

  if (data.count === 0) return null
  return (
    <mesh
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
  useEffect(() => () => geometry.dispose(), [geometry])
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
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <mesh
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
    () => () => {
      geometry.dispose()
    },
    [geometry],
  )

  return (
    <mesh
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
  geometry.setIndex(base.getIndex())
  for (const name of Object.keys(base.attributes)) {
    geometry.setAttribute(name, base.getAttribute(name))
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
