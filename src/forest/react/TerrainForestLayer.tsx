import { Fragment, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Object3D } from 'three/webgpu'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import { invalidateTerrainShadows } from '../../terrain/rendering/environment/terrainShadowInvalidation'
import {
  DistanceLodForest,
  ForestMaterialPreloader,
  PrototypeCompiler,
} from '../../tree/ForestRenderer'
import { ForestFloorProps } from '../../tree/ForestFloorProps'
import type { GeneratedForestRock } from '../../tree/forestPresets'
import type { TreePlacement, TreeEditorStore } from '../../tree/TreeEditorStore'
import type { TreeSpecies } from '../../tree/generator/types'
import { useTreeEditorSnapshot } from '../../tree/useTreeEditorSnapshot'
import { TreeImpostorBand } from '../../tree/impostor/TreeImpostorBand'
import {
  IMPOSTOR_FADE_END,
  IMPOSTOR_FADE_START,
  useImpostorSplit,
} from '../../tree/impostor/useImpostorSplit'
import type { ProceduralTreeAsset } from '../../tree/generator/types'
import type { TreeLodLevel } from '../../tree/generator/types'
import { createGroundSampler, type ForestFieldStore } from '../ForestFieldStore'
import { useForestFieldSnapshot } from './useForestFieldSnapshot'

/**
 * Geometry compiles stay serialised here for the same reason they do in the
 * lab: each one saturates a core for about a second, and the machine has four.
 */
const MAX_CONCURRENT_TREE_COMPILERS = 1

/**
 * Every forest drawn on the terrain, drawn.
 *
 * The prototypes are the tree lab's — a field references a catalogue variation
 * by id and never authors one — so the two workspaces share one compiled asset
 * per variation, one texture bake and one set of pipelines however many forests
 * are standing in the world.
 */
export function TerrainForestLayer({
  terrain,
  forest,
  trees,
  warmup,
}: {
  terrain: WorldTerrain
  forest: ForestFieldStore
  trees: TreeEditorStore
  warmup?: (object: Object3D) => Promise<void>
}) {
  const fields = useForestFieldSnapshot(forest)
  const catalogue = useTreeEditorSnapshot(trees)

  const visibleFieldIds = useMemo(
    () => new Set(fields.fields.filter((field) => field.visible).map((field) => field.id)),
    [fields.fields],
  )

  const bakes = useMemo(
    () => Object.values(fields.bakes).filter((bake) => visibleFieldIds.has(bake.fieldId)),
    [fields.bakes, visibleFieldIds],
  )

  // Placements from every field, merged and grouped by the prototype they draw
  // through. Grouping is what keeps the draw count proportional to the number
  // of distinct trees rather than to the number of forests.
  const byPrototype = useMemo(() => {
    const groups = new Map<string, TreePlacement[]>()
    for (const bake of bakes) {
      for (const placement of bake.placements) {
        const group = groups.get(placement.prototypeId)
        if (group) group.push(placement)
        else groups.set(placement.prototypeId, [placement])
      }
    }
    return groups
  }, [bakes])

  const placements = useMemo(
    () => bakes.flatMap((bake) => bake.placements),
    [bakes],
  )
  const rocks = useMemo<GeneratedForestRock[]>(
    () => bakes.flatMap((bake) => [...bake.rocks]),
    [bakes],
  )
  const groundNormals = useMemo(() => {
    const merged = new Map<string, readonly [number, number, number]>()
    for (const bake of bakes) {
      for (const [id, normal] of bake.groundNormals) merged.set(id, normal)
    }
    return merged
  }, [bakes])

  // The catalogue only ever gains entries here, and only the ones a bake
  // actually referenced.
  const requiredIds = useMemo(
    () => [...new Set(bakes.flatMap((bake) => [...bake.prototypeIds]))].sort().join(','),
    [bakes],
  )
  useEffect(() => {
    if (requiredIds.length === 0) return
    trees.ensurePrototypes(
      requiredIds.split(',').map((id) => {
        const separator = id.lastIndexOf(':')
        return {
          species: id.slice(0, separator) as TreeSpecies,
          variation: Number(id.slice(separator + 1)),
        }
      }),
    )
  }, [requiredIds, trees])

  const used = useMemo(() => new Set(byPrototype.keys()), [byPrototype])
  const prototypes = useMemo(
    () => Object.values(catalogue.prototypes).filter((prototype) => used.has(prototype.id)),
    [catalogue.prototypes, used],
  )
  const activeCompilers = prototypes.filter((prototype) => prototype.building)
  const queued = prototypes
    .filter(
      (prototype) =>
        !prototype.building && prototype.compiledRevision !== prototype.buildRevision,
    )
    .slice(0, Math.max(0, MAX_CONCURRENT_TREE_COMPILERS - activeCompilers.length))
  const compiling = [...activeCompilers, ...queued]

  // A stand that appears while the camera is still casts nothing until the
  // camera moves, because the shadow cascades only redraw when something says
  // the scene changed. Growing a forest is exactly such a change.
  const shadowKey = `${placements.length}:${rocks.length}:` +
    prototypes.map((prototype) => `${prototype.id}@${prototype.compiledRevision ?? -1}`).join(',')
  useEffect(() => {
    invalidateTerrainShadows()
  }, [shadowKey])

  return (
    <>
      <ForestBakeDriver terrain={terrain} forest={forest} />
      <ForestMaterialPreloader prototypes={prototypes} />
      {compiling.map((prototype) => (
        <PrototypeCompiler key={prototype.id} prototype={prototype} store={trees} />
      ))}

      <ForestFloorProps
        placements={placements}
        prototypes={catalogue.prototypes}
        rocks={rocks}
        groundNormals={groundNormals}
      />

      {[...byPrototype].map(([prototypeId, group]) => {
        const prototype = catalogue.prototypes[prototypeId]
        const asset = prototype?.asset
        if (!asset) return null
        const standing = group.filter((placement) => !placement.tilt)
        const fallen = group.filter((placement) => placement.tilt)
        return (
          <Fragment key={`${prototypeId}:${prototype.compiledRevision ?? 0}`}>
            {standing.length > 0 && (
              <PrototypeStand
                asset={asset}
                instances={standing}
                lodBias={catalogue.lod}
                showFoliage={catalogue.showFoliage}
                impostors={catalogue.impostors}
                warmup={warmup}
              />
            )}
            {/*
              Deadfall stays geometry at every range. It lies on the ground, so
              it is only ever seen close up, and a card is a picture taken from
              a standing tree's bearings — a fallen trunk sampled from them is
              a tree lying on its side seen edge-on.
            */}
            {fallen.length > 0 && (
              <DistanceLodForest
                asset={asset}
                instances={fallen}
                lodBias={catalogue.lod}
                showFoliage={false}
                warmup={warmup}
              />
            )}
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * One prototype's standing stems, across the whole distance range.
 *
 * The near band is the existing three-level geometry chain; everything beyond
 * it is cards. A field can hold thousands of stems and only the nearest hundred
 * or so can be geometry on this hardware, so without the card band a forest
 * either has to be small or has to end abruptly — which is what the impostors
 * exist to fix. See `TreeImpostorBand`.
 */
function PrototypeStand({
  asset,
  instances,
  lodBias,
  showFoliage,
  impostors,
  warmup,
}: {
  asset: ProceduralTreeAsset
  instances: readonly TreePlacement[]
  lodBias: TreeLodLevel
  showFoliage: boolean
  impostors: boolean
  warmup?: (object: Object3D) => Promise<void>
}) {
  const split = useImpostorSplit(instances)
  // With the card band off, the geometry chain carries the whole stand as it
  // always did — which is the honest fallback, not a degraded one, for a copse
  // small enough that every stem can be geometry.
  const near = impostors ? split.near : instances
  return (
    <>
      {near.length > 0 && (
        <DistanceLodForest
          asset={asset}
          instances={near}
          lodBias={lodBias}
          showFoliage={showFoliage}
          warmup={warmup}
        />
      )}
      {impostors && split.far.length > 0 && (
        <TreeImpostorBand
          asset={asset}
          instances={split.far}
          nearFadeStart={IMPOSTOR_FADE_START}
          nearFadeEnd={IMPOSTOR_FADE_END}
        />
      )}
    </>
  )
}

/**
 * Grows the fields that need it, one per frame.
 *
 * A bake is a coverage raster, a rejection-sampled layout over up to six
 * hundred thousand candidates and a terrain height query per accepted stem —
 * a hundred milliseconds or so for a large field. One per frame is what keeps
 * that from becoming half a second of one frame when a viewer nudges the
 * density slider with four forests in the world.
 */
function ForestBakeDriver({
  terrain,
  forest,
}: {
  terrain: WorldTerrain
  forest: ForestFieldStore
}) {
  const sampler = useRef(createGroundSampler((x, z) => terrain.sampleHeight(x, z)))
  useEffect(() => {
    sampler.current = createGroundSampler((x, z) => terrain.sampleHeight(x, z))
  }, [terrain])

  useFrame(() => {
    const field = forest.nextDirtyField()
    if (!field) return
    forest.bakeField(field, sampler.current)
  })
  return null
}
