import { useCallback, useRef, type PropsWithChildren } from 'react'
import { Canvas } from '@react-three/fiber'
import {
  ACESFilmicToneMapping,
  WebGPURenderer,
  type WebGPURendererParameters,
} from 'three/webgpu'

export function WebGpuCanvas({ children }: PropsWithChildren) {
  const rendererPromise = useRef<Promise<WebGPURenderer> | null>(null)
  const createRenderer = useCallback((canvas: HTMLCanvasElement) => {
    // R3F v9 can re-enter an async gl factory while it is still resolving.
    // Returning one in-flight renderer prevents two WebGPU contexts from
    // racing to own the same canvas with differently sized depth targets.
    rendererPromise.current ??= createWebGpuRenderer(canvas)
    return rendererPromise.current
  }, [])

  return (
    <Canvas
      gl={async (defaults) =>
        createRenderer(defaults.canvas as HTMLCanvasElement)
      }
      camera={{
        position: [238, 176, 264],
        fov: 48,
        near: 0.5,
        far: 80_000,
      }}
      dpr={[1, 1.6]}
      frameloop="always"
      performance={{ min: 0.5, max: 1, debounce: 300 }}
    >
      {children}
    </Canvas>
  )
}

async function createWebGpuRenderer(canvas: HTMLCanvasElement) {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser')
  const parameters: WebGPURendererParameters = {
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  }
  const renderer = new WebGPURenderer(parameters)
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  sizeRendererToCanvas(renderer, canvas)
  await renderer.init()
  // The CSS layout may settle while requestAdapter/requestDevice is pending.
  // Refresh every attachment before R3F submits the first render pass.
  sizeRendererToCanvas(renderer, canvas)
  return renderer
}

function sizeRendererToCanvas(
  renderer: WebGPURenderer,
  canvas: HTMLCanvasElement,
): void {
  const bounds = canvas.getBoundingClientRect()
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.6)
  renderer.setPixelRatio(pixelRatio)
  renderer.setSize(
    Math.max(1, Math.round(bounds.width)),
    Math.max(1, Math.round(bounds.height)),
    false,
  )
}
