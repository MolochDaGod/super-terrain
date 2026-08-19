import { useEffect, useMemo, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { ACESFilmicToneMapping, AgXToneMapping, PCFSoftShadowMap } from 'three/webgpu'
import type { Camera, Renderer, Scene } from 'three/webgpu'
import { createTerrainRenderPipeline } from '../rendering/post/createTerrainRenderPipeline'
import type { TerrainRenderMode } from '../rendering/renderModes'

export interface TerrainRenderPipelineProps {
  mode: TerrainRenderMode
  onCompilingChange?: (compiling: boolean) => void
  beforeRender?: (renderer: Renderer, scene: Scene, camera: Camera) => void
}

/**
 * Takes ownership of the frame. A `useFrame` priority above zero disables R3F's
 * automatic render, which is what lets the scene go through the tone-mapped
 * post chain instead of straight to the swap chain.
 *
 * Switching to `full` swaps in a large procedural shader, and WebGPU creates
 * its pipeline lazily on first use — synchronously, inside the frame. On a
 * mid-range GPU that stall runs into seconds, which the browser's GPU watchdog
 * treats as a hang and answers by dropping the device. So the pipelines are
 * warmed through `compileAsync`, which uses `createRenderPipelineAsync`
 * underneath, and no frame is submitted until it resolves.
 */
export function TerrainRenderPipeline({
  mode,
  onCompilingChange,
  beforeRender,
}: TerrainRenderPipelineProps) {
  const { gl, scene, camera, size } = useThree()
  const [readyMode, setReadyMode] = useState<TerrainRenderMode | null>(null)

  const rendering = useMemo(
    () =>
      createTerrainRenderPipeline(
        gl as unknown as Renderer,
        scene as unknown as Scene,
        camera,
        mode,
      ),
    [camera, gl, mode, scene],
  )

  useEffect(() => {
    const renderer = gl as unknown as Renderer
    // AgX keeps a sky several stops above the ground from clipping while
    // leaving shadowed rock readable; ACES crushes both ends of that range.
    renderer.toneMapping = mode === 'full' ? AgXToneMapping : ACESFilmicToneMapping
    renderer.toneMappingExposure = mode === 'full' ? 0.95 : 1.08
    renderer.shadowMap.enabled = mode === 'full'
    renderer.shadowMap.type = PCFSoftShadowMap
  }, [gl, mode])

  useEffect(() => {
    let cancelled = false
    setReadyMode(null)
    onCompilingChange?.(true)
    void rendering
      .warmup()
      .then(() => {
        if (cancelled) return
        setReadyMode(mode)
        onCompilingChange?.(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        console.error('Terrain pipeline warm-up failed', error)
        onCompilingChange?.(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode, onCompilingChange, rendering])

  useEffect(() => () => rendering.dispose(), [rendering])

  useEffect(() => {
    rendering.pipeline.needsUpdate = true
  }, [rendering, size.height, size.width])

  useFrame(() => {
    // Holding the previous frame for a moment is a far better failure mode than
    // submitting work that outlives the watchdog.
    if (readyMode !== mode) return
    beforeRender?.(
      gl as unknown as Renderer,
      scene as unknown as Scene,
      camera,
    )
    rendering.pipeline.render()
  }, 1)

  return null
}
