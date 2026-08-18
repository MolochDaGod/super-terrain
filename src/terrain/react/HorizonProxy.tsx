import { useEffect, useMemo, useState } from 'react'
import type { BufferGeometry } from 'three/webgpu'
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
  worldSize,
  seed,
  mode,
}: {
  worldSize: number
  seed: number
  mode: TerrainRenderMode
}) {
  const [geometry, setGeometry] = useState<BufferGeometry>()
  const material = useMemo(() => createHorizonProxyMaterial(mode), [mode])

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
    worker.postMessage({ worldSize, seed })
    return () => {
      active = false
      worker.terminate()
    }
  }, [seed, worldSize])

  useEffect(
    () => () => {
      material.dispose()
    },
    [material],
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
    />
  )
}
