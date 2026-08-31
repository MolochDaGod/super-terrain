import { useEffect, useMemo, useRef } from 'react'
import { createPortal, useFrame, useThree } from '@react-three/fiber'
import {
  AmbientLight,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  Scene,
  type Renderer,
} from 'three/webgpu'
import { TreeForestAssetView, type ForestTreeInstance } from '../TreeAssetView'
import type { ProceduralTreeAsset } from '../generator/types'
import {
  bakeNextView,
  createTreeImpostorAtlas,
  type TreeImpostorAtlas,
} from './treeImpostorAtlas'
import { createTreeImpostorMaterial } from './treeImpostorMaterial'

/**
 * The far half of one prototype's forest, drawn as baked cards.
 *
 * This is the distance band that made a forest affordable. `DistanceLodForest`
 * gives a stand three levels of real geometry, and all three are geometry — so
 * a field of a few thousand stems is a few thousand trees' worth of triangles
 * however coarse the far ones are, and the measured ceiling on this machine is
 * a little over a hundred and fifty. Past the handover distance a conifer is a
 * silhouette with some shading in it, and two triangles carrying a baked
 * picture of that silhouette cost about a four-thousandth of the geometry.
 *
 * It hangs off a prototype rather than owning a tree of its own. The forest
 * fields reference the tree lab's catalogue by id, the catalogue compiles each
 * variation exactly once, and this bakes cards from that same compiled asset —
 * so a card and the real tree it dissolves into are the same plant, and adding
 * the band costs no extra tree compile.
 *
 * Neither the bake nor the placement may stall a frame:
 *
 *   - the sixteen atlas views are rendered one per frame, so a new prototype
 *     coming into view spreads its bake over a quarter of a second of ordinary
 *     frames rather than landing as a hitch
 *   - the atlas and the instance buffers are allocated once at full capacity,
 *     so cards begin drawing on the first baked view and simply improve over
 *     the next fifteen, with no pipeline recompiled and no material rebuilt
 */

export interface TreeImpostorBandProps {
  /** The compiled prototype these cards are a picture of. */
  asset: ProceduralTreeAsset
  /** The stems far enough away to be drawn as cards. */
  instances: readonly ForestTreeInstance[]
  /** Metres over which cards dissolve into the real geometry. */
  nearFadeStart: number
  nearFadeEnd: number
}

export function TreeImpostorBand({
  asset,
  instances,
  nearFadeStart,
  nearFadeEnd,
}: TreeImpostorBandProps) {
  const renderer = useThree((state) => state.gl) as unknown as Renderer

  // The scene the bake camera renders.
  //
  // Detached from the editor's scene, and it has to be: it carries its own
  // lights so the bake is lit at all, and adding it to the main scene — even
  // with `visible` false — puts those lights into the editor's light list and
  // relights the whole world. `createPortal` mounts the tree into it without
  // the group ever joining the scene graph.
  const bakeScene = useMemo(() => {
    const scene = new Scene()
    // Lit the way the editor lights the world, so a distant card sits at the
    // same value as the real tree it will cross-fade into rather than being a
    // swatch that has to be tuned by eye against whatever is behind it.
    const key = new DirectionalLight(0xffd9b0, 3.85)
    key.position.set(220, 180, -300)
    // The target has to be in the scene: a DirectionalLight aims at its
    // target's world matrix, and a target that was never added is never
    // updated, which leaves the light pointing nowhere and the tree unlit.
    key.target.position.set(0, 0, 0)
    scene.add(key.target)
    const sky = new HemisphereLight(0x8fa2a2, 0x3f4c3d, 1.45)
    const fill = new AmbientLight(0x3f4c3d, 0.5)
    scene.add(key, sky, fill)
    return scene
  }, [])

  const subject = useMemo(() => {
    const group = new Group()
    bakeScene.add(group)
    return group
  }, [bakeScene])

  const atlas = useMemo<TreeImpostorAtlas>(
    () => createTreeImpostorAtlas(asset.lods[0].wood.bounds),
    [asset],
  )
  useEffect(() => () => atlas.dispose(), [atlas])

  const material = useMemo(
    () =>
      createTreeImpostorMaterial({
        atlas: atlas.albedo.texture,
        radius: atlas.radius,
        halfHeight: atlas.halfHeight,
        centreHeight: atlas.centreHeight,
        nearFadeStart,
        nearFadeEnd,
      }),
    [atlas, nearFadeEnd, nearFadeStart],
  )
  useEffect(() => () => material.dispose(), [material])

  // Capacity grows in powers of two and never shrinks.
  //
  // Resizing an instanced attribute rebuilds the geometry and the draw, so this
  // must not track the stem count directly — a field being edited changes count
  // on every regrow. But it must not be frozen at mount either: a field grown
  // from a hundred stems to five thousand would silently draw the first
  // thousand and drop the rest, which reads as the forest having a hole in it
  // rather than as a buffer limit. Doubling gives at most a handful of rebuilds
  // over a field's whole editing life.
  const allocated = useRef(0)
  const needed = Math.max(1024, nextPowerOfTwo(instances.length))
  if (needed > allocated.current) allocated.current = needed
  const capacity = allocated.current

  const geometry = useMemo(() => {
    const quad = new PlaneGeometry(1, 1)
    const instanced = new InstancedBufferGeometry()
    // Copied, not aliased and then disposed: handing the instanced geometry the
    // quad's own attribute objects and disposing the quad releases the buffers
    // this geometry still points at, and the draw silently produces nothing.
    instanced.index = quad.index
    instanced.attributes = quad.attributes
    instanced.setAttribute(
      'impostorPlacement',
      new InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
    )
    instanced.setAttribute(
      'impostorVariation',
      new InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
    )
    instanced.instanceCount = 0
    return instanced
  }, [capacity])
  useEffect(() => () => geometry.dispose(), [geometry])

  const mesh = useMemo(() => {
    const created = new Mesh(geometry, material)
    created.name = 'tree-impostors'
    // The cards are placed in world space by the vertex stage, so the object's
    // transform is the identity and its bounds cannot be derived from the
    // geometry. Frustum culling would drop the whole band the moment the origin
    // left the view.
    created.frustumCulled = false
    return created
  }, [geometry, material])

  useEffect(() => {
    const placement = geometry.getAttribute('impostorPlacement') as InstancedBufferAttribute
    const variation = geometry.getAttribute('impostorVariation') as InstancedBufferAttribute
    const count = Math.min(instances.length, capacity)
    for (let index = 0; index < count; index += 1) {
      const tree = instances[index]!
      const [x, y, z] = tree.position
      placement.setXYZW(index, x, y, z, tree.scale)
      // Derived from the placement id rather than stored, so a card and the
      // geometry it replaces get the same bearing and the same spread without
      // the forest bake having to carry two extra fields per stem.
      const spread = hashUnit(tree.id)
      variation.setXYZW(
        index,
        tree.rotation,
        fract(spread * 7.31),
        fract(spread * 13.77),
        0,
      )
    }
    placement.needsUpdate = true
    variation.needsUpdate = true
    geometry.instanceCount = count
  }, [capacity, geometry, instances])

  const baked = useRef(false)
  useFrame(() => {
    if (baked.current) return
    // The tree arrives in two stages: the compiled asset, and then the bark and
    // leaf textures, which `TreeForestAssetView` bakes asynchronously and only
    // mounts meshes after. Baking before those meshes exist renders sixteen
    // empty cells, stops, and leaves cards that alpha-test away to nothing.
    if (!hasDrawableMesh(subject)) return
    // Exactly one view per frame. See the note at the top of this file.
    if (!bakeNextView(atlas, renderer, bakeScene, subject)) baked.current = true
  })

  return (
    <>
      {createPortal(
        <TreeForestAssetView
          asset={asset}
          instances={BAKE_INSTANCE}
          lodLevel={0}
          showFoliage
          selectedId={undefined}
          selectionProxyInstances={null}
        />,
        subject,
      )}
      <primitive object={mesh} />
    </>
  )
}

/** One tree at the origin, unrotated: what every card is a picture of. */
const BAKE_INSTANCE: ForestTreeInstance[] = [
  { id: 'impostor-bake', position: [0, 0, 0], rotation: 0, scale: 1 },
]

/** Whether anything in the bake subject would actually rasterise. */
function hasDrawableMesh(root: Group): boolean {
  let found = false
  root.traverse((object) => {
    if (found) return
    const mesh = object as Mesh
    if (mesh.isMesh && mesh.visible && mesh.geometry) found = true
  })
  return found
}

function nextPowerOfTwo(value: number): number {
  let size = 1
  while (size < value) size *= 2
  return size
}

function hashUnit(id: string): number {
  let value = 2_166_136_261
  for (let index = 0; index < id.length; index += 1) {
    value ^= id.charCodeAt(index)
    value = Math.imul(value, 16_777_619)
  }
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295
}

function fract(value: number): number {
  return value - Math.floor(value)
}
