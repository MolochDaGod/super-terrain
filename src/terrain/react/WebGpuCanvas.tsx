import { useCallback, useRef, type PropsWithChildren } from 'react'
import { Canvas } from '@react-three/fiber'
import {
  ACESFilmicToneMapping,
  WebGPURenderer,
  type WebGPURendererParameters,
} from 'three/webgpu'
import { installClusteredWebgpuLighting } from '@workspace/clustered-webgpu-lighting'
import { currentViewUrlState } from './viewUrlState'

interface WebGpuCanvasProps extends PropsWithChildren {
  dpr: number
  cameraPosition?: [number, number, number]
}

export function WebGpuCanvas({ children, dpr, cameraPosition }: WebGpuCanvasProps) {
  const rendererPromise = useRef<Promise<WebGPURenderer> | null>(null)
  const initialDpr = useRef(dpr)
  const view = useRef(currentViewUrlState())
  const createRenderer = useCallback((canvas: HTMLCanvasElement) => {
    // R3F v9 can re-enter an async gl factory while it is still resolving.
    // Returning one in-flight renderer prevents two WebGPU contexts from
    // racing to own the same canvas with differently sized depth targets.
    rendererPromise.current ??= createWebGpuRenderer(canvas, initialDpr.current)
    return rendererPromise.current
  }, [])

  return (
    <Canvas
      gl={async (defaults) =>
        createRenderer(defaults.canvas as HTMLCanvasElement)
      }
      camera={{
        position: cameraPosition ?? view.current.position ?? [0, 175, -170],
        fov: view.current.fov ?? 50,
        near: 0.5,
        far: 80_000,
      }}
      dpr={dpr}
      // R3F owns this. It writes `gl.shadowMap.enabled` from this prop inside
      // its own `configure` pass, which runs after component effects — so a
      // component that enables shadows itself has them switched back off a
      // moment later and the whole scene renders unshadowed with every mesh
      // still dutifully flagged `castShadow`. Declaring it here is the only
      // place the setting survives.
      shadows="soft"
      frameloop="always"
      performance={{ min: 0.5, max: 1, debounce: 300 }}
    >
      {children}
    </Canvas>
  )
}

/**
 * Limits raised past the guaranteed floor, clamped to what this adapter has.
 *
 * WebGPU guarantees only sixteen sampled textures per shader stage, and the
 * full terrain material is close to it: it samples its own surface, detail,
 * relief and paint maps and then, under a forest, the painted floor as well.
 * Crossing the line does not degrade — the render pipeline fails to create, the
 * material draws nothing, and the only evidence is a validation message in the
 * console. Adding three ground-cover textures to it did exactly that.
 *
 * Every desktop adapter offers far more than the floor (48 sampled textures
 * here), so the headroom is free where it exists. It is requested through
 * `min` with the adapter's own report rather than asked for outright, because
 * `requestDevice` *fails* if a required limit cannot be met — asking for more
 * than a weak adapter has would turn a material that renders slightly wrong
 * into an editor that does not start.
 */
async function headroomLimits(): Promise<Record<string, number>> {
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  })
  if (!adapter) return {}
  const wanted: Record<string, number> = {
    maxSampledTexturesPerShaderStage: 32,
    // The mask writes one storage texture per weight row, plus the surfaces and
    // the sward summary. The guaranteed floor for those is four.
    maxStorageTexturesPerShaderStage: 8,
  }
  const limits: Record<string, number> = {}
  const available = adapter.limits as unknown as Record<string, number>
  for (const [name, value] of Object.entries(wanted)) {
    const supported = available[name]
    if (typeof supported === 'number') limits[name] = Math.min(value, supported)
  }
  return limits
}

async function createWebGpuRenderer(canvas: HTMLCanvasElement, dpr: number) {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser')
  const parameters: WebGPURendererParameters = {
    requiredLimits: await headroomLimits(),
    canvas,
    antialias: true,
    // Stated explicitly, because alpha-to-coverage is only a smoothing tool at
    // all when there are samples to dither across. Foliage cutouts fall back to
    // hard binary edges the moment the sample count drops to one.
    samples: 4,
    alpha: false,
    powerPreference: 'high-performance',
    // Timestamp queries carry a small synchronization cost, so keep them out
    // of normal runs and opt in only for the CDP performance harness.
    trackTimestamp: new URLSearchParams(location.search).has('gpuTiming'),
  }
  const renderer = new WebGPURenderer(parameters)
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.03
  sizeRendererToCanvas(renderer, canvas, dpr)
  await renderer.init()
  // Three's native WebGPU light path is the shipped default. In this scene it
  // preserves the real point-light energy inside the two CSG chambers and is
  // just as fast as the clustered path at the current light count. Keep the
  // clustered renderer available as an explicit stress-test mode for editors
  // that add hundreds of lights, rather than silently weakening local bounce.
  if (new URLSearchParams(location.search).has('clustered')) {
    installClusteredWebgpuLighting(renderer)
  }
  // The CSS layout may settle while requestAdapter/requestDevice is pending.
  // Refresh every attachment before R3F submits the first render pass.
  sizeRendererToCanvas(renderer, canvas, dpr)
  return renderer
}

function sizeRendererToCanvas(
  renderer: WebGPURenderer,
  canvas: HTMLCanvasElement,
  dpr: number,
): void {
  const bounds = canvas.getBoundingClientRect()
  renderer.setPixelRatio(dpr)
  renderer.setSize(
    Math.max(1, Math.round(bounds.width)),
    Math.max(1, Math.round(bounds.height)),
    false,
  )
}
