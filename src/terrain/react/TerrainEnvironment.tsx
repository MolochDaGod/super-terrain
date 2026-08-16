import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Scene } from 'three/webgpu'
import type { TerrainConfig } from '../config'
import { createTerrainEnvironment } from '../rendering/environment/createTerrainEnvironment'
import type { TerrainRenderMode } from '../rendering/renderModes'

/**
 * Sky, sun and ambient for the active render mode. Kept out of JSX so the exact
 * same construction runs in the offline capture harness.
 */
export function TerrainEnvironment({
  mode,
  config,
}: {
  mode: TerrainRenderMode
  config: TerrainConfig
}) {
  const { scene } = useThree()
  const environment = useMemo(
    () => createTerrainEnvironment(mode, config),
    [config, mode],
  )

  useEffect(() => {
    environment.applyToScene(scene as unknown as Scene)
    return () => environment.dispose()
  }, [environment, scene])

  useFrame((state) => {
    environment.update(state.camera)
  })

  return <primitive object={environment.group} />
}
