import { useEffect, useMemo, useRef } from 'react'
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
import { cameraPosition, normalWorld, positionWorld, texture, vec3 } from 'three/tsl'
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
  bakeProceduralTreeTextures,
  type LeafCardTextures,
  type ProceduralTreeTextures,
} from './materials/proceduralTreeTextures'
import { createLeafCardGeometry, splitFoliageByVariant } from './materials/leafCardGeometry'
import { DEFAULT_SUN } from '../terrain/rendering/environment/sunPosition'

/** How much light a lit blade passes through when the sun is behind it. */
const LEAF_TRANSMISSION = 0.6
/** Floor the shaded hemisphere is lifted to, so the far side is not a slab. */
const LEAF_AMBIENT_WRAP = 0.34
const SUN_DIRECTION: [number, number, number] = [
  DEFAULT_SUN.direction.x,
  DEFAULT_SUN.direction.y,
  DEFAULT_SUN.direction.z,
]

export function TreeAssetView({
  asset,
  lodLevel,
  debugMode,
  showFoliage,
}: {
  asset: ProceduralTreeAsset
  lodLevel: TreeLodLevel
  debugMode: TreeDebugMode
  showFoliage: boolean
}) {
  const lod = asset.lods[lodLevel]
  const woodGeometry = useTreeGeometry(lod.wood)
  const textures = useMemo(
    () => bakeProceduralTreeTextures(asset.parameters.species, asset.parameters.seed),
    [asset.parameters.seed, asset.parameters.species],
  )
  const woodMaterial = useMemo(
    () =>
      new MeshStandardNodeMaterial({
        name: 'procedural bark pbr',
        vertexColors: true,
        map: textures.barkMap,
        normalMap: textures.barkNormalMap,
        // Bark relief lives entirely in this map — the sweep only carries the
        // member's macro shape — so it has to be pushed past unity or the
        // furrows read as paint rather than as centimetres of depth.
        normalScale: new Vector2(2.1, 2.1),
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
  useEffect(() => () => textures.dispose(), [textures])
  useEffect(() => () => debugGeometry.dispose(), [debugGeometry])

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
    // Light. The card's own bowed geometry already fans the normals across the
    // spray; stacking a strong per-leaf tangent normal on top of that turns
    // every blade into its own hard-lit facet and the crown into glitter.
    normalScale: new Vector2(0.4, 0.4),
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
  const sun = vec3(...SUN_DIRECTION)
  // Roughness in R, blade translucency in G. Reading roughness from a channel
  // rather than a whole second texture keeps the leaf atlas to three maps.
  // Floored high. Leaves have a waxy cuticle, not a varnish, and a low floor
  // put a hard specular sheen on every blade that read as wet plastic.
  material.roughnessNode = texture(card.surfaceMap).r.mul(0.34).add(0.62)

  // Leaves are thin and they transmit. A standard opaque BRDF gives the side of
  // the crown facing away from the sun nothing but the ambient term, which is
  // why the back of the tree came out as a flat, intensely dark green slab —
  // physically the correct answer for a rock, and completely wrong for a
  // hundred thousand translucent blades stacked a few centimetres apart.
  //
  // Two terms fix it, and both are cheap. A wrapped diffuse lifts the shaded
  // hemisphere instead of letting it fall to zero at the terminator, and a
  // view-dependent transmission adds the green glow you get looking through a
  // canopy toward the sun. Together they keep the shaded side coloured and
  // luminous rather than black.
  const albedo = texture(card.map).rgb
  const transmission = texture(card.surfaceMap).g
  const facing = normalWorld.dot(sun)
  const wrapped = facing.mul(0.5).add(0.5).pow(1.4)
  const throughLeaf = positionWorld.sub(cameraPosition).normalize().dot(sun)
    .max(0).pow(2.2)
  material.emissiveNode = albedo.mul(
    wrapped.mul(LEAF_AMBIENT_WRAP).add(
      transmission.mul(throughLeaf).mul(LEAF_TRANSMISSION),
    ),
  )
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
