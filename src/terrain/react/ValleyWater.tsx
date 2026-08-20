import { useEffect, useMemo } from 'react'
import { reflector } from 'three/tsl'
import { WATER_LEVEL, WATER_REGION } from '../demo/valleyFloor'
import { createWaterMaterial } from '../rendering/water/createWaterMaterial'
import { createWaterSurface } from '../rendering/water/createWaterSurface'
import type { WorldTerrain } from '../WorldTerrain'
import type { TerrainRenderMode } from '../rendering/renderModes'

interface ValleyWaterProps {
  terrain: WorldTerrain
  mode: TerrainRenderMode
}

/**
 * The water in the basin. Only in `full` mode: the preview material has no sky
 * model to reflect, so the same surface there is a flat grey sheet that reads
 * as a bug rather than as a river.
 */
export function ValleyWater({ terrain, mode }: ValleyWaterProps) {
  const seed = terrain.config.seed
  const geometry = useMemo(
    () => createWaterSurface({ region: WATER_REGION, level: WATER_LEVEL, seed }),
    [seed],
  )

  const { material, reflectionTarget } = useMemo(() => {
    // A second pass over the whole scene, so it is rendered at a fraction of
    // the frame's resolution. The ripple distortion hides the difference, and a
    // reflection sharp enough to count pixels in is not what this is for.
    const reflection = reflector({ resolutionScale: 0.2, bounces: false })
    // The node's `target` is what defines the mirror plane: its local +Z is the
    // plane normal, so it is laid flat and lifted to the water level. The water
    // geometry is already in world space on a mesh at the origin, so the target
    // cannot simply be parented to it.
    reflection.target.rotateX(-Math.PI / 2)
    reflection.target.position.y = WATER_LEVEL
    return {
      material: createWaterMaterial({ reflection }),
      reflectionTarget: reflection.target,
    }
  }, [])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  if (mode !== 'full') return null
  return (
    <>
      <primitive object={reflectionTarget} />
      <mesh geometry={geometry} material={material} renderOrder={-1} />
    </>
  )
}
