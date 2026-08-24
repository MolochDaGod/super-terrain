import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicNodeMaterial,
  Matrix4,
  MeshStandardNodeMaterial,
  Vector2,
} from 'three/webgpu'
import { texture } from 'three/tsl'
import type {
  ProceduralTreeAsset,
  SemanticTreeGraph,
  TreeFoliageData,
  TreeLodLevel,
  TreeMeshData,
  TreeSpineSample,
  TreeVec3,
} from './generator/types'
import type { TreeDebugMode } from './TreeEditorStore'
import {
  type LeafCardTextures,
  type ProceduralTreeTextures,
} from './materials/proceduralTreeTextures'
import { bakeProceduralTreeTexturesAsync } from './materials/proceduralTreeTextureClient'
import { createLeafCardGeometry, splitFoliageByVariant } from './materials/leafCardGeometry'

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
  const woodMaterial = useMemo(
    () =>
      new MeshStandardNodeMaterial({
        name: 'procedural bark pbr',
        vertexColors: true,
        map: textures.barkMap,
        normalMap: textures.barkNormalMap,
        // The mesh already carries the trunk's macro fluting. The normal map
        // supplies bark plates and grain only; pushing it beyond unity made
        // every fissure an ink-black engraved line with no matching silhouette.
        normalScale: new Vector2(0.85, 0.85),
        roughnessMap: textures.barkRoughnessMap,
        roughness: 1,
        metalness: 0,
      }),
    [textures],
  )
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
    () => createDebugGeometry(asset.graph, debugMode),
    [asset.graph, debugMode],
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
  const surfaceVisible = debugMode === 'surface' || debugMode === 'topology'

  useEffect(
    () => () => {
      woodMaterial.dispose()
      topologyMaterial.dispose()
      debugMaterial.dispose()
    },
    [debugMaterial, topologyMaterial, woodMaterial],
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
        <FoliageInstances
          data={lod.foliage}
          lodLevel={lodLevel}
          textures={textures}
        />
      )}
    </group>
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

/**
 * One instanced batch per atlas spray. Instances carry no per-instance UV, so
 * varying the artwork means varying the material — four batches is a trivial
 * cost next to giving every card its own draw or building a custom attribute
 * path for the sake of one texture lookup.
 */
function FoliageInstances({
  data,
  lodLevel,
  textures,
}: {
  data: TreeFoliageData
  lodLevel: TreeLodLevel
  textures: ProceduralTreeTextures
}) {
  const batches = useMemo(() => splitFoliageByVariant(data), [data])
  if (data.count === 0) return null
  if (data.representation === 'clusters') {
    return (
      <FoliageBatch
        key="clusters"
        name="foliage-clusters"
        matrices={data.matrices}
        colors={data.colors}
        count={data.count}
        card={undefined}
        lodLevel={lodLevel}
      />
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
            card={textures.leafCards[variant] ?? textures.leafCards[0]}
            lodLevel={lodLevel}
          />
        ),
      )}
    </group>
  )
}

function FoliageBatch({
  name,
  matrices,
  colors,
  count,
  card,
  lodLevel,
}: {
  name: string
  matrices: Float32Array
  colors: Float32Array
  count: number
  card: LeafCardTextures | undefined
  lodLevel: TreeLodLevel
}) {
  const instances = useRef<InstancedMesh>(null)
  const geometry = useMemo(
    () => (card ? createLeafCardGeometry() : new IcosahedronGeometry(1, 1)),
    [card],
  )
  const material = useMemo(() => createFoliageMaterial(card), [card])

  useEffect(() => {
    const mesh = instances.current
    if (!mesh) return
    const matrix = new Matrix4()
    const color = new Color()
    for (let index = 0; index < count; index += 1) {
      mesh.setMatrixAt(index, matrix.fromArray(matrices, index * 16))
      mesh.setColorAt(index, color.fromArray(colors, index * 3))
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [colors, count, matrices])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  return (
    <instancedMesh
      ref={instances}
      name={name}
      args={[geometry, material, count]}
      castShadow={lodLevel === 0}
      receiveShadow
      frustumCulled
    />
  )
}

function createFoliageMaterial(card: LeafCardTextures | undefined) {
  if (!card) {
    return new MeshStandardNodeMaterial({
      name: 'far foliage mass',
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
    })
  }
  const material = new MeshStandardNodeMaterial({
    name: 'leaf spray card',
    color: 0xffffff,
    vertexColors: true,
    map: card.map,
    normalMap: card.normalMap,
    // Enough tangent relief to separate the blades within a spray, while the
    // bowed card still provides the branchlet-scale change in orientation.
    normalScale: new Vector2(0.42, 0.42),
    roughness: 1,
    metalness: 0,
    side: DoubleSide,
    // A soft threshold plus alpha-to-coverage: hard-cut leaf edges are the
    // single most recognisable "game foliage from 2010" artefact, and MSAA
    // coverage dithering removes it without paying for sorted transparency.
    alphaTest: 0.3,
    alphaToCoverage: true,
    depthWrite: true,
  })
  // Roughness in R, blade translucency in G. Reading roughness from a channel
  // rather than a whole second texture keeps the leaf atlas to three maps.
  // Use the authored cuticle response directly. The previous remap forced
  // every value into 0.8–0.95 and made living leaves read as dry construction
  // paper. Clamping only guards corrupt/legacy atlases.
  material.roughnessNode = texture(card.surfaceMap).r.clamp(0.38, 0.76)

  // Deliberately no emissive foliage term. The old wrapped-light/transmission
  // approximation ignored sun visibility, so leaves continued to glow inside
  // the shadowed crown. Until transmission can consume the actual direct-light
  // shadow factor, ordinary lit double-sided foliage is the honest result.
  return material
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
