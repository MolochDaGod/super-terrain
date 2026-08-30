import { useEffect, useMemo, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { ACESFilmicToneMapping, AgXToneMapping } from 'three/webgpu'
import type { Camera, Object3D, Renderer, Scene } from 'three/webgpu'
import { createTerrainRenderPipeline } from '../rendering/post/createTerrainRenderPipeline'
import type { PostLook } from '../rendering/post/createTerrainRenderPipeline'
import type { TerrainRenderMode } from '../rendering/renderModes'
import { drainGpuRetirementsForFrame } from '../rendering/gpuResourceRetirement'
import { currentViewUrlState } from './viewUrlState'

export interface TerrainRenderPipelineProps {
  mode: TerrainRenderMode
  look?: PostLook
  /**
   * Tone-mapping exposure, when the look's own default is wrong for the
   * subject. The terrain workspace runs the tree look's post chain — haze,
   * light shafts, bloom — over a landscape rather than an interior, and an
   * interior's exposure would print that landscape a third of a stop hot.
   */
  exposure?: number
  onCompilingChange?: (compiling: boolean) => void
  beforeRender?: (renderer: Renderer, scene: Scene, camera: Camera) => void
  prewarmObject?: Object3D | null
  prewarmKey?: string
  onPrewarmComplete?: (key: string) => void
  onPrewarmError?: (key: string, error: unknown) => void
  /**
   * Publishes this pass's object warm-up so a layer mounted elsewhere in the
   * scene can compile against the same multisampled attachment. Compiling
   * against the swap chain instead produces a different pipeline key and moves
   * the stall to the first post-processed frame rather than removing it.
   */
  onWarmupReady?: (warm: (object: Object3D) => Promise<void>) => void
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
/** Grading exposure for `full`. A review pass can override it with `?exposure=`. */
// Graded for the evening key. AgX puts a 7-degree sun's lit rock near the
// bottom of its range, and at the editor's old 0.95 everything the sun missed
// fell off the curve entirely.
const FULL_EXPOSURE = 1.18
/**
 * A forest interior is a low-key subject. Most of the frame is under a canopy
 * and the few sunlit patches are meant to be the brightest things in it, so the
 * exposure sits below the landscape's — printing an interior at landscape
 * exposure is what turns a stand into an overlit model of one.
 */
const TREE_EXPOSURE = 1.4

export function TerrainRenderPipeline({
  mode,
  look = 'terrain',
  exposure,
  onCompilingChange,
  beforeRender,
  prewarmObject,
  prewarmKey,
  onPrewarmComplete,
  onPrewarmError,
  onWarmupReady,
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
        true,
        look,
      ),
    [camera, gl, look, mode, scene],
  )

  useEffect(() => {
    const renderer = gl as unknown as Renderer
    // AgX keeps a sky several stops above the ground from clipping while
    // leaving shadowed rock readable; ACES crushes both ends of that range.
    renderer.toneMapping = mode === 'full' ? AgXToneMapping : ACESFilmicToneMapping
    renderer.toneMappingExposure =
      currentViewUrlState().exposure ??
        exposure ??
        (mode === 'full' ? (look === 'tree' ? TREE_EXPOSURE : FULL_EXPOSURE) : 1.08)
    // Shadow map enablement and type are declared on the Canvas instead: R3F
    // rewrites both from its `shadows` prop after effects run, so setting them
    // here is silently undone. Preview mode has no shadow-casting lights and no
    // meshes flagged to cast, so leaving the map enabled there costs nothing.
  }, [exposure, gl, look, mode])

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
    onWarmupReady?.(rendering.warmupObject)
  }, [onWarmupReady, rendering])

  useEffect(() => {
    if (!prewarmObject || prewarmKey === undefined) return
    let cancelled = false
    void rendering.warmupObject(prewarmObject).then(
      () => {
        if (!cancelled) onPrewarmComplete?.(prewarmKey)
      },
      (error: unknown) => {
        if (!cancelled) onPrewarmError?.(prewarmKey, error)
      },
    )
    return () => {
      // WebGPU pipeline creation itself is not abortable. Ignoring completion
      // prevents a superseded asset from becoming visible or overwriting the
      // status of the newer generation; React then disposes its staged data.
      cancelled = true
    }
  }, [onPrewarmComplete, onPrewarmError, prewarmKey, prewarmObject, rendering])

  useEffect(() => {
    rendering.pipeline.needsUpdate = true
  }, [rendering, size.height, size.width])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    globals.__post = { godrays: rendering.godrayControls }
    return () => {
      delete globals.__post
    }
  }, [rendering])

  useFrame(() => {
    // The top of the frame is the one point where the renderer owns no open
    // command encoder, which is what makes destroying GPU buffers safe here
    // and nowhere else.
    drainGpuRetirementsForFrame()
    // Holding the previous frame for a moment is a far better failure mode than
    // submitting work that outlives the watchdog.
    if (readyMode !== mode) return
    beforeRender?.(
      gl as unknown as Renderer,
      scene as unknown as Scene,
      camera,
    )
    // Effects that need their own pass — the sun depth map the light shafts
    // march against — run here, after the scene is settled and before the post
    // chain reads them.
    rendering.updateEffects?.()
    rendering.pipeline.render()
  }, 1)

  return null
}
