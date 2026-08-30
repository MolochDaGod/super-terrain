import { useCallback, useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { MathUtils, Vector3 } from 'three/webgpu'
import type { Object3D } from 'three/webgpu'
import { TreeForestAssetView, type ForestTreeInstance } from './TreeAssetView'
import type { ProceduralTreeAsset, TreeLodLevel, TreeSpecies } from './generator/types'
import { DEFAULT_TREE_ENVIRONMENT } from './generator/types'
import { preloadProceduralTreeTextures } from './materials/proceduralTreeTextureClient'
import { treeMaterialSeed } from './materials/proceduralTreeTextures'
import { generateTreeAsset } from './treeGeneratorClient'
import type { TreeEditorStore, TreePrototype } from './TreeEditorStore'

/**
 * The parts of the forest renderer both workspaces run.
 *
 * The tree lab and the terrain editor draw the same thing — a set of shared
 * prototypes, instanced across a set of placements, each placement given its
 * own distance LOD — and only differ in where the placements come from. Keeping
 * one copy is not tidiness: distance banding, LOD hysteresis, the material
 * preload wave and the serialised compiler queue are all tuned against measured
 * numbers recorded in the comments below, and a second copy of them would drift
 * from those measurements the first time either workspace was touched.
 */

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
export function DistanceLodForest({
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
export function ForestMaterialPreloader({
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

export function PrototypeCompiler({
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
