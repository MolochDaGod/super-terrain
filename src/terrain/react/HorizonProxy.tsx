import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  ClampToEdgeWrapping,
  DataTexture,
  NearestFilter,
  RedFormat,
  UnsignedByteType,
  type BufferGeometry,
} from 'three/webgpu'
import type { WorldTerrain } from '../WorldTerrain'
import type { FarFieldMeshData } from '../rendering/FarFieldMesh'
import { createFarFieldGeometry } from '../rendering/createFarFieldGeometry'
import { createHorizonProxyMaterial } from '../rendering/createHorizonProxyMaterial'
import type { TerrainRenderMode } from '../rendering/renderModes'

const HORIZON_PROXY_RENDER_ORDER = -100

/**
 * Ultra-cheap fallback below the streamed working set. It prevents a visible
 * void at the residency boundary while nearby partition meshes remain the
 * authoritative rendered surface.
 */
export function HorizonProxy({
  terrain,
  mode,
}: {
  terrain: WorldTerrain
  mode: TerrainRenderMode
}) {
  const { worldSize, seed } = terrain.config
  const [geometry, setGeometry] = useState<BufferGeometry>()
  const residentMask = useMemo(() => {
    const mask = terrain.getHorizonProxyMask()
    const result = new DataTexture(
      mask.data,
      mask.width,
      mask.height,
      RedFormat,
      UnsignedByteType,
    )
    result.name = 'terrain horizon proxy residency mask'
    result.wrapS = ClampToEdgeWrapping
    result.wrapT = ClampToEdgeWrapping
    result.magFilter = NearestFilter
    result.minFilter = NearestFilter
    result.generateMipmaps = false
    result.flipY = false
    result.needsUpdate = true
    return result
  }, [terrain])
  const maskRevision = useRef(terrain.getHorizonProxyMask().revision)
  const material = useMemo(
    () => createHorizonProxyMaterial(mode, residentMask, worldSize),
    [mode, residentMask, worldSize],
  )

  useFrame(() => {
    const mask = terrain.getHorizonProxyMask()
    if (maskRevision.current === mask.revision) return
    residentMask.needsUpdate = true
    maskRevision.current = mask.revision
  })

  useEffect(() => {
    let active = true
    const worker = new Worker(
      new URL('../workers/farField.worker.ts', import.meta.url),
      { type: 'module', name: 'terrain-far-field' },
    )
    worker.onmessage = (event: MessageEvent<FarFieldMeshData>) => {
      const next = createFarFieldGeometry(event.data)
      if (active) setGeometry(next)
      else next.dispose()
      worker.terminate()
    }
    worker.postMessage({ worldSize, seed, worldProfile: terrain.config.worldProfile })
    return () => {
      active = false
      worker.terminate()
    }
  }, [terrain, seed, worldSize])

  useEffect(
    () => () => {
      material.dispose()
      residentMask.dispose()
    },
    [material, residentMask],
  )
  useEffect(() => () => geometry?.dispose(), [geometry])

  if (!geometry) return null
  return (
    <mesh
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={HORIZON_PROXY_RENDER_ORDER}
      receiveShadow
      // Preserve the correctly depth-sorted proxy colour as a backdrop, but
      // discard its coarse depth before resident terrain and authored objects
      // render. Otherwise an interpolated proxy chord can reject the more
      // accurate resident surface where their working sets overlap.
      onAfterRender={(renderer) => renderer.clearDepth()}
    />
  )
}
