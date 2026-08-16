import { useEffect, useMemo, useState } from 'react'
import { MeshStandardNodeMaterial, type BufferGeometry } from 'three/webgpu'
import { attribute, float, vec3, varying, vertexColor } from 'three/tsl'
import type { FarFieldMeshData } from '../rendering/FarFieldMesh'
import { createFarFieldGeometry } from '../rendering/createFarFieldGeometry'
import type { TerrainRenderMode } from '../rendering/renderModes'

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
  const material = useMemo(() => {
    const next = new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
    })
    next.colorNode =
      mode === 'full'
        ? varying(
            vec3(attribute('farFieldFullColor', 'vec3') as any),
            'farFieldFullColour',
          )
        : vertexColor()
    // The proxy is a backdrop, not a second physical surface. Keep its true
    // world elevation for lighting and height-based mist, but write far-plane
    // depth so every resident section wins wherever the two overlap.
    next.depthNode = float(1)
    return next
  }, [mode])

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
      renderOrder={-100}
      receiveShadow
    />
  )
}
