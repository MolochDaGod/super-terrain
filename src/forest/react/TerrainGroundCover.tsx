import { useEffect, useMemo, useRef } from 'react'
import { useTexture } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import {
  RepeatWrapping,
  SRGBColorSpace,
  type Object3D,
  type Renderer,
} from 'three/webgpu'
import groundArmUrl from '../../terrain/react/assets/rock-ground-arm-1k.jpg'
import groundMapUrl from '../../terrain/react/assets/rock-ground-diffuse-1k.jpg'
import groundNormalUrl from '../../terrain/react/assets/rock-ground-normal-gl-1k.jpg'
import { FoliageSystem } from '../../foliage/FoliageSystem'
import { foliageSpeciesIndex } from '../../foliage/foliageSpecies'
import { foliageSurfaceIndex } from '../../foliage/foliageSurfaces'
import type { FoliageFloorRecipe } from '../../foliage/foliageFloor'
import type { FoliageEditorStore } from '../../foliage/FoliageEditorStore'
import {
  bindForestFloorMask,
  setForestFloorOrigin,
  unbindForestFloorMask,
} from '../../foliage/forestFloorBlend'
import { useFoliageSnapshot } from '../../foliage/react/useFoliageSnapshot'
import { forestFloorRecipe } from '../../tree/forestFloors'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { ForestFieldStore } from '../ForestFieldStore'
import type { ForestRegion } from '../forestField'
import { useForestFieldSnapshot } from './useForestFieldSnapshot'

/** Metres of soil texture per tile. */
const SOIL_TILE_SIZE = 5

/**
 * Metres the painted window covers.
 *
 * A kilometre. The mask is 512 cells across it, so a cell is two metres — four
 * times coarser than the lab's, and the right trade for this workspace: nothing
 * here is painted by hand at brush scale, the shapes come from splines whose
 * own fringe is tens of metres, and what the extra reach buys is a whole forest
 * plus its surroundings inside one window, so flying around a stand does not
 * keep re-rasterising it.
 */
const WINDOW_SIZE = 1024

/**
 * How far the camera may drift from the window centre before it is recentred,
 * as a fraction of the window. A quarter leaves a comfortable margin past the
 * furthest ring the population kernel draws (262 m) in every direction.
 */
const RECENTRE_FRACTION = 0.25

/** Region paint dispatches per frame. Each is one pass over the 512² mask. */
const REGION_JOBS_PER_FRAME = 3

/**
 * Ground cover inside the forests drawn on the terrain.
 *
 * The lab paints its floor by hand and keeps it; this does not. Here the
 * splines are the record and the mask is a cache: whenever the window moves or
 * a field changes, the mask is cleared and every field overlapping the window
 * is rasterised into it again from its own preset's floor recipe. That is what
 * lets a forest exist anywhere in a four-kilometre world without storing a
 * texel of painted data, and it is why there is no ground-cover brush on this
 * side — editing the field's recipe is the edit.
 */
export function TerrainGroundCover({
  terrain,
  forest,
  foliage,
  warmup,
}: {
  terrain: WorldTerrain
  forest: ForestFieldStore
  foliage: FoliageEditorStore
  warmup?: (object: Object3D) => Promise<void>
}) {
  const renderer = useThree((state) => state.gl) as unknown as Renderer
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  const dpr = useThree((state) => state.viewport.dpr)
  const fields = useForestFieldSnapshot(forest)
  const settings = useFoliageSnapshot(foliage)

  const [map, normalMap, armMap] = useTexture([
    groundMapUrl,
    groundNormalUrl,
    groundArmUrl,
  ])
  useMemo(() => {
    for (const texture of [map, normalMap, armMap]) {
      texture.wrapS = RepeatWrapping
      texture.wrapT = RepeatWrapping
      texture.anisotropy = 8
      texture.needsUpdate = true
    }
    map.colorSpace = SRGBColorSpace
  }, [armMap, map, normalMap])

  const system = useMemo(
    () =>
      new FoliageSystem({
        map,
        normalMap,
        armMap,
        tileSize: SOIL_TILE_SIZE,
        soilTint: [1, 1, 1],
        fieldSize: WINDOW_SIZE,
        // The terrain is the floor. See `FoliageSystemOptions.drawGround`.
        drawGround: false,
      }),
    [armMap, map, normalMap],
  )
  useEffect(() => () => system.dispose(), [system])

  // The terrain material shades the floor itself, from this same mask. Binding
  // is what switches that on; until a ground-cover layer exists, the blend is a
  // multiply by zero.
  useEffect(() => {
    bindForestFloorMask(system.mask)
    return () => unbindForestFloorMask()
  }, [system])

  const warmed = useRef(false)
  useEffect(() => {
    system.group.visible = false
    if (!warmup) {
      warmed.current = true
      return
    }
    let cancelled = false
    void warmup(system.group).then(
      () => {
        if (!cancelled) warmed.current = true
      },
      (error: unknown) => {
        if (cancelled) return
        console.error('Ground cover warm-up failed', error)
        warmed.current = true
      },
    )
    return () => {
      cancelled = true
    }
  }, [system, warmup])

  // Development handle. How many clumps a ring actually placed is only
  // knowable by reading back its indirect draw argument, which is a GPU
  // readback: fine from a console, never in the frame loop.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    globals.__terrainFoliage = {
      system,
      counts: async () =>
        Promise.all(
          system.rings.map(async (ring) => {
            const buffer = await (
              renderer as unknown as {
                getArrayBufferAsync(attribute: unknown): Promise<ArrayBuffer>
              }
            ).getArrayBufferAsync(ring.geometry.indirect)
            return { ring: ring.config.name, drawn: new Uint32Array(buffer)[1] }
          }),
        ),
      region: () => {
        const array = (system.mask.region.values as { value: { array: Float32Array } })
          .value.array
        let max = 0
        let nonZero = 0
        for (const value of array) {
          if (value > max) max = value
          if (value > 0.001) nonZero += 1
        }
        return {
          max,
          nonZero,
          origin: system.mask.region.origin.value.toArray(),
          extent: system.mask.region.extent.value.toArray(),
        }
      },
      mask: async () => {
        const buffer = await (
          renderer as unknown as {
            getArrayBufferAsync(attribute: unknown): Promise<ArrayBuffer>
          }
        ).getArrayBufferAsync(
          (system.mask.buffer as { value: unknown }).value,
        )
        const values = new Float32Array(buffer)
        let max = 0
        let nonZero = 0
        for (const value of values) {
          if (value > max) max = value
          if (value > 0.01) nonZero += 1
        }
        return { max, nonZero, length: values.length }
      },
    }
    return () => {
      delete globals.__terrainFoliage
    }
  }, [renderer, system])

  const jobs = useRef<((renderer: Renderer) => void)[]>([])
  const window = useRef<{ x: number; z: number } | null>(null)
  // Bumped by anything that invalidates the cache: a new bake, a field hidden,
  // a preset changed. The window moving does the same thing by a different
  // route, so both end at `rebuild`.
  const bakeKey = useMemo(
    () =>
      fields.fields
        .filter((field) => field.visible)
        .map((field) => `${field.id}:${field.preset}:${fields.bakes[field.id] ? 1 : 0}`)
        .join(',') + `|${Object.keys(fields.bakes).length}`,
    [fields.bakes, fields.fields],
  )
  const rebuildKey = useRef('')

  const elapsed = useRef(0)

  useFrame((_, delta) => {
    elapsed.current += Math.min(delta, 0.1)

    const centre = window.current
    const moved =
      !centre ||
      Math.abs(camera.position.x - centre.x) > WINDOW_SIZE * RECENTRE_FRACTION ||
      Math.abs(camera.position.z - centre.z) > WINDOW_SIZE * RECENTRE_FRACTION

    if (moved || rebuildKey.current !== bakeKey) {
      // Snapped to a whole eighth of the window so successive recentres land on
      // the same lattice, rather than tracking the camera continuously and
      // re-rasterising every field on every frame of a slow pan.
      const snap = WINDOW_SIZE / 8
      const x = Math.round(camera.position.x / snap) * snap
      const z = Math.round(camera.position.z / snap) * snap
      window.current = { x, z }
      rebuildKey.current = bakeKey
      system.mask.setOrigin(x, z)
      setForestFloorOrigin(x, z)
      system.ground3d.update(x, z, WINDOW_SIZE, (sx, sz) => terrain.sampleHeight(sx, sz))
      jobs.current = buildRegionJobs(system, fields, x, z)
    }

    // Clearing is the first job in the queue, so the old cover survives until
    // the frame the new one starts arriving rather than blinking out first.
    let ran = 0
    while (jobs.current.length > 0 && ran < REGION_JOBS_PER_FRAME) {
      jobs.current.shift()!(renderer)
      ran += 1
    }
    if (ran > 0) system.markPopulationDirty()

    system.setDensity(settings.density)
    system.setWind(settings.wind)
    // A world with no forests in it pays nothing. Population is four ring
    // dispatches plus the debris pass every time the camera moves, and running
    // them over an empty mask to place nothing is the kind of cost that is
    // invisible in a profile and permanent in a frame budget.
    const active = jobs.current.length > 0 || Object.keys(fields.bakes).length > 0
    system.group.visible = warmed.current && settings.visible && active
    if (!system.group.visible) return
    system.update(renderer, camera, elapsed.current, Math.max(1, size.height * dpr))
  }, 0.4)

  return <primitive object={system.group} />
}

/**
 * The recipe for every visible field, as one dispatch per channel.
 *
 * The colony scatter the lab uses — dozens of soft dabs per species — is not
 * reproduced here and should not be: it exists to give a 400-metre floor
 * structure at colony scale, and the region kernel gets the same structure from
 * a noise field at the same scale for one dispatch instead of thirty. What is
 * kept is the recipe's *shares*, because those are what distinguish a needle
 * duff under spruce from deep broadleaf litter.
 */
function buildRegionJobs(
  system: FoliageSystem,
  fields: ReturnType<typeof useForestFieldSnapshot>,
  centreX: number,
  centreZ: number,
): ((renderer: Renderer) => void)[] {
  const jobs: ((renderer: Renderer) => void)[] = [
    (renderer) => system.clear(renderer),
  ]
  const half = WINDOW_SIZE * 0.5

  for (const field of fields.fields) {
    if (!field.visible) continue
    const bake = fields.bakes[field.id]
    if (!bake) continue
    const region = bake.region
    // Windows and fields that do not overlap cost nothing.
    if (
      region.bounds.maxX < centreX - half ||
      region.bounds.minX > centreX + half ||
      region.bounds.maxZ < centreZ - half ||
      region.bounds.minZ > centreZ + half
    ) {
      continue
    }

    const recipe = forestFloorRecipe(field.preset)
    const channels = floorChannels(recipe)
    jobs.push(() => uploadRegion(system, region))
    for (const channel of channels) {
      jobs.push((renderer) => system.mask.paintRegion(renderer, channel))
    }
  }
  return jobs
}

function uploadRegion(system: FoliageSystem, region: ForestRegion): void {
  const width = region.bounds.maxX - region.bounds.minX
  const depth = region.bounds.maxZ - region.bounds.minZ
  system.mask.setRegion(
    region.bounds.minX + width * 0.5,
    region.bounds.minZ + depth * 0.5,
    width,
    depth,
    (x, z) => region.coverage(x, z),
  )
}

interface RegionChannel {
  channel: number
  layer: 'plants' | 'surface'
  weight: number
  noiseScale: number
  noiseAmount: number
}

function floorChannels(recipe: FoliageFloorRecipe): RegionChannel[] {
  const channels: RegionChannel[] = []

  for (const wash of recipe.surfaces) {
    // A wash covers the whole floor; patches are a partial second pass. Their
    // flows are averaged into one weight because the region kernel lays a
    // single field per channel and the patch structure comes from its noise.
    const patchFlow = wash.flow ? (wash.flow[0] + wash.flow[1]) / 2 : 0
    const patchShare = wash.count ? Math.min(1, wash.count / 24) : 0
    const weight = Math.min(1, (wash.fill ?? 0) + patchFlow * patchShare)
    if (weight <= 0.01) continue
    channels.push({
      channel: foliageSurfaceIndex(wash.surface),
      layer: 'surface',
      weight,
      noiseScale: wash.radius ? (wash.radius[0] + wash.radius[1]) : 40,
      // A field-wide wash is the floor itself and should be continuous; a
      // patchy layer over it is what the noise is for.
      noiseAmount: wash.fill && wash.fill > 0.6 ? 0.18 : 0.5,
    })
  }

  const byPlant = new Map<string, { flow: number; radius: number; count: number }>()
  for (const colony of recipe.colonies) {
    const flow = (colony.flow[0] + colony.flow[1]) / 2
    const radius = (colony.radius[0] + colony.radius[1]) / 2
    const existing = byPlant.get(colony.species)
    if (existing) {
      existing.flow = Math.max(existing.flow, flow)
      existing.radius = (existing.radius + radius) / 2
      existing.count += colony.count
    } else {
      byPlant.set(colony.species, { flow, radius, count: colony.count })
    }
  }
  for (const [species, entry] of byPlant) {
    // How much of the floor the colonies of this plant would have covered.
    // A single huge dab — the lab's way of writing "this one is everywhere" —
    // saturates it, which is the intent.
    const share = Math.min(1, (entry.count * entry.radius * entry.radius) / (150 * 150))
    const weight = Math.min(0.95, entry.flow * (0.35 + 0.65 * share))
    if (weight <= 0.01) continue
    channels.push({
      channel: foliageSpeciesIndex(species as never),
      layer: 'plants',
      weight,
      noiseScale: Math.max(8, entry.radius * 1.6),
      noiseAmount: 0.55,
    })
  }

  return channels
}
