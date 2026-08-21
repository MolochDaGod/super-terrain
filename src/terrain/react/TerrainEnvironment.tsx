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
import { createTerrainEnvironment } from '../rendering/environment/createTerrainEnvironment'
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
}: {
  mode: TerrainRenderMode
  config: TerrainConfig
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
    () => createTerrainEnvironment(mode, config, { skyTexture }),
    [config, mode, skyTexture],
  )

  useEffect(() => {
    environment.applyToScene(scene as unknown as Scene)
    return () => environment.dispose()
  }, [environment, scene])

  // Camera controls run at the default priority and the post pipeline renders
  // at priority 1. Refresh camera-dependent shadows between those two phases.
  useFrame((state) => {
    environment.update(state.camera)
  }, 0.5)

  return <primitive object={environment.group} />
}
