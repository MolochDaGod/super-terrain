import { useEffect, useMemo, useRef, useState } from 'react'
import { reflector } from 'three/tsl'
import type { BufferGeometry } from 'three/webgpu'
import { createPreviewWaterMaterial } from '../rendering/water/createPreviewWaterMaterial'
import { createWaterMaterial } from '../rendering/water/createWaterMaterial'
import { createWaterSurface } from '../rendering/water/createWaterSurface'
import { EXCLUDE_FROM_SUN_DEPTH } from '../rendering/post/sunDepthMap'
import type { WorldTerrain } from '../WorldTerrain'
import type { TerrainRenderMode } from '../rendering/renderModes'
import { useWaterState } from './hooks'

interface ValleyWaterProps {
  terrain: WorldTerrain
  mode: TerrainRenderMode
}

/** Vertices the surface grid is allowed to spend, whatever extent it covers. */
const MAX_SURFACE_VERTICES = 260_000

/**
 * The world's standing water.
 *
 * The mesh is rebuilt from the painted coverage mask, so it is not a fixture of
 * the demo scene any more — a stroke of the water brush changes what this
 * builds. Rebuilds are debounced because a mask edit arrives once per pointer
 * move and remeshing a lake at every sample would stall the drag that is
 * painting it.
 */
export function ValleyWater({ terrain, mode }: ValleyWaterProps) {
  const seed = terrain.config.seed
  const water = terrain.water
  const { enabled, level, turbidity, revision } = useWaterState(terrain)
  const [geometry, setGeometry] = useState<BufferGeometry | undefined>(undefined)
  const geometryRef = useRef<BufferGeometry | undefined>(undefined)

  useEffect(() => {
    const build = () => {
      const region = water.bounds()
      const next = region
        ? createWaterSurface({
            region,
            level,
            seed,
            step: surfaceStep(region.max.x - region.min.x, region.max.z - region.min.z),
            coverage: (x, z) => water.sample(x, z),
          })
        : undefined
      geometryRef.current?.dispose()
      geometryRef.current = next
      setGeometry(next)
    }
    // The first build has to be immediate, or the shipped scene would present a
    // dry basin for a fifth of a second on every load. Only later rebuilds —
    // the ones a brush is driving — are worth debouncing.
    if (!geometryRef.current) {
      build()
      return
    }
    const handle = setTimeout(build, 180)
    return () => clearTimeout(handle)
  }, [level, revision, seed, water])

  useEffect(
    () => () => {
      geometryRef.current?.dispose()
      geometryRef.current = undefined
    },
    [],
  )

  const { resources, reflectionTarget } = useMemo(() => {
    // A second pass over the whole scene, so it is rendered at a fraction of
    // the frame's resolution. The ripple distortion hides the difference, and a
    // reflection sharp enough to count pixels in is not what this is for.
    const reflection = reflector({ resolutionScale: 0.64, bounces: false })
    // The node's `target` is what defines the mirror plane: its local +Z is the
    // plane normal, so it is laid flat and lifted to the water level. The water
    // geometry is already in world space on a mesh at the origin, so the target
    // cannot simply be parented to it.
    reflection.target.rotateX(-Math.PI / 2)
    return {
      resources: createWaterMaterial({ reflection }),
      reflectionTarget: reflection.target,
    }
  }, [])

  // The mirror plane follows the level, so raising the water does not leave the
  // reflection behind at the height the scene loaded with.
  useEffect(() => {
    reflectionTarget.position.y = level
  }, [level, reflectionTarget])

  const previewMaterial = useMemo(
    () => createPreviewWaterMaterial(turbidity),
    [turbidity],
  )
  useEffect(() => () => previewMaterial.dispose(), [previewMaterial])
  useEffect(() => () => resources.dispose(), [resources])

  if (!enabled || !geometry) return null
  if (mode !== 'full') {
    return <mesh geometry={geometry} material={previewMaterial} renderOrder={-1} />
  }
  return (
    <>
      <primitive object={reflectionTarget} />
      <mesh
        geometry={geometry}
        material={resources.material}
        renderOrder={-1}
        // Kept out of the godray depth pass. That pass draws with real
        // materials, and drawing this one from the sun camera hands the
        // reflector its one update for the frame — see `EXCLUDE_FROM_SUN_DEPTH`.
        userData={SUN_DEPTH_EXCLUDED}
      />
    </>
  )
}

const SUN_DEPTH_EXCLUDED = { [EXCLUDE_FROM_SUN_DEPTH]: true } as const

/**
 * Grid spacing for an extent.
 *
 * Three metres is what the demo's basin needs to keep a narrow channel from
 * showing its cell outline. A lake painted across a kilometre gets a coarser
 * grid instead of forty times the vertices: at that size the shoreline is far
 * enough away that the terrain's own occlusion carries it.
 */
function surfaceStep(width: number, depth: number): number {
  const area = Math.max(1, width) * Math.max(1, depth)
  return Math.max(3, Math.sqrt(area / MAX_SURFACE_VERTICES))
}
