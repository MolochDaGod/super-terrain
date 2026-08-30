import { useEffect, useMemo } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import {
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type Scene,
} from 'three/webgpu'
import type { TerrainConfig } from '../config'
import {
  createTerrainEnvironment,
  type TerrainEnvironmentLook,
} from '../rendering/environment/createTerrainEnvironment'
import type { TerrainRenderMode } from '../rendering/renderModes'

const CINEMATIC_SKY_URL = new URL(
  './assets/alpine-sky.jpg',
  import.meta.url,
).href

/**
 * Sky, sun and ambient for the active render mode. Kept out of JSX so the exact
 * same construction runs in the offline capture harness.
 */
export function TerrainEnvironment({
  mode,
  config,
  look = 'terrain',
  shadows = true,
  updatePriority = 0.5,
}: {
  mode: TerrainRenderMode
  config: TerrainConfig
  /** Which light rig to build. See `TerrainEnvironmentLook`. */
  look?: TerrainEnvironmentLook
  /**
   * Sun shadows. Turning them off rebuilds the rig without a shadow-casting
   * light, which is the only way the cascade passes actually stop costing
   * anything — leaving the maps enabled and the meshes flagged still renders
   * them.
   */
  shadows?: boolean
  /**
   * The terrain post stack owns rendering at priority 1, so its environment
   * update runs just ahead of it. Standalone workspaces use priority 0 to keep
   * R3F's automatic frame submission alive.
   */
  updatePriority?: number
}) {
  const { scene } = useThree()
  const skyTexture = useLoader(TextureLoader, CINEMATIC_SKY_URL)
  useMemo(() => {
    skyTexture.name = 'late-afternoon alpine cloud panorama'
    skyTexture.wrapS = RepeatWrapping
    skyTexture.magFilter = LinearFilter
    skyTexture.minFilter = LinearMipmapLinearFilter
    skyTexture.generateMipmaps = true
    skyTexture.anisotropy = 8
    skyTexture.colorSpace = SRGBColorSpace
    skyTexture.repeat.set(1, 1)
    skyTexture.needsUpdate = true
  }, [skyTexture])
  const environment = useMemo(
    () => createTerrainEnvironment(mode, config, { skyTexture, look, shadows }),
    [config, look, mode, shadows, skyTexture],
  )

  useEffect(() => {
    environment.applyToScene(scene as unknown as Scene)
    return () => environment.dispose()
  }, [environment, scene])

  // Camera controls run at the default priority and the post pipeline renders
  // at priority 1. Refresh camera-dependent shadows between those two phases.
  useFrame((state) => {
    environment.update(state.camera)
  }, updatePriority)

  return <primitive object={environment.group} />
}
