import { useCallback, useRef, type PropsWithChildren } from 'react'
import { Canvas } from '@react-three/fiber'
import {
  ACESFilmicToneMapping,
  WebGPURenderer,
  type WebGPURendererParameters,
} from 'three/webgpu'
import { installClusteredWebgpuLighting } from '@workspace/clustered-webgpu-lighting'

interface WebGpuCanvasProps extends PropsWithChildren {
  dpr: number
}

export function WebGpuCanvas({ children, dpr }: WebGpuCanvasProps) {
  const rendererPromise = useRef<Promise<WebGPURenderer> | null>(null)
  const initialDpr = useRef(dpr)
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
        position: [230, 280, -90],
        fov: 48,
        near: 0.5,
        far: 80_000,
      }}
      dpr={dpr}
      frameloop="always"
      performance={{ min: 0.5, max: 1, debounce: 300 }}
    >
      {children}
    </Canvas>
  )
}

async function createWebGpuRenderer(canvas: HTMLCanvasElement, dpr: number) {
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
  sizeRendererToCanvas(renderer, canvas, dpr)
  await renderer.init()
  installClusteredWebgpuLighting(renderer)
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
