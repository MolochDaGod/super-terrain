import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { WorldTerrain } from '../WorldTerrain'
import { TerrainRockField } from '../rocks/TerrainRockField'
import { WATER_LEVEL } from '../demo/valleyFloor'

/**
 * The loose rock on the terrain.
 *
 * Mounted beside `TerrainView` rather than inside it because the two answer
 * different questions. A terrain section is a streamed, compiled, LOD-selected
 * piece of the world and its lifetime is owned by the streamer; the rock field
 * is a single camera-anchored ring that exists wherever the camera is, and
 * tying it to section lifetimes would mean rebuilding it every time a section
 * swapped underneath it.
 *
 * It samples `terrain.sampleHeight` directly. That is the same function the
 * compiler used to build the mesh the rocks are standing on, so a rock is on
 * the ground by construction rather than by a tolerance — and it stays there
 * across an LOD swap, which a raycast against the drawn mesh would not.
 */
export function TerrainRocks({
  terrain,
  visible = true,
}: {
  terrain: WorldTerrain
  visible?: boolean
}) {
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)

  const field = useMemo(
    () => new TerrainRockField({ seed: terrain.config.seed }),
    [terrain],
  )

  const surface = useMemo(
    () => ({
      height: (x: number, z: number) => terrain.sampleHeight(x, z),
      waterLevel: WATER_LEVEL,
    }),
    [terrain],
  )

  useEffect(() => {
    scene.add(field.group)
    return () => {
      scene.remove(field.group)
      field.dispose()
    }
  }, [field, scene])

  useEffect(() => {
    field.setVisible(visible)
  }, [field, visible])

  // Behind the terrain's own frame work: the rock field's placement reads the
  // height function the streamer keeps warm, so running first would sample it
  // while a section swap is still in flight.
  useFrame(() => {
    if (!visible) return
    field.update(camera.position.x, camera.position.z, surface)
  }, 0.5)

  return null
}
