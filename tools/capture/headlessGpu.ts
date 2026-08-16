import { createRequire } from 'node:module'
import { WebGPURenderer, RenderTarget, SRGBColorSpace } from 'three/webgpu'

const require = createRequire(import.meta.url)

interface DawnModule {
  create(flags: string[]): GPU
  destroy(instance: GPU): void
  [key: string]: unknown
}

export interface HeadlessRenderer {
  renderer: WebGPURenderer
  capture(render: () => Promise<void>): Promise<Uint8Array>
  /**
   * Renders without reading pixels back, waiting for the GPU to finish. The
   * readback in `capture` costs more than the frame does, so timings taken
   * around it measure the transfer rather than the renderer.
   */
  timeFrame(render: () => Promise<void>): Promise<void>
  dispose(): void
}

/**
 * Boots three's WebGPU renderer on Google Dawn inside Node. There is no DOM, so
 * the canvas and the swap-chain context are stubbed; every frame is rendered
 * into an offscreen render target that we read back for the PNG.
 */
/**
 * WebGPU buffer copies require rows padded to 256 bytes. Rather than unpack a
 * padded readback, capture widths are constrained to a multiple of 64 pixels
 * (64 x 4 bytes = 256) so the returned rows are already tightly packed.
 */
export function alignCaptureWidth(width: number): number {
  return Math.max(64, Math.round(width / 64) * 64)
}

export async function createHeadlessRenderer(
  width: number,
  height: number,
): Promise<HeadlessRenderer> {
  if (width % 64 !== 0) {
    throw new Error(
      `capture: width must be a multiple of 64, got ${width} (use ${alignCaptureWidth(width)})`,
    )
  }
  const dawn = require('@kmamal/gpu') as DawnModule
  for (const [key, value] of Object.entries(dawn)) {
    if (key.startsWith('GPU') && (globalThis as Record<string, unknown>)[key] === undefined) {
      ;(globalThis as Record<string, unknown>)[key] = value
    }
  }
  // three's Animation loop and a few node utilities expect browser globals.
  ;(globalThis as Record<string, unknown>).self = globalThis
  globalThis.requestAnimationFrame ??= (callback) =>
    setTimeout(() => callback(performance.now()), 16) as unknown as number
  globalThis.cancelAnimationFrame ??= (handle) => clearTimeout(handle)

  const instance = dawn.create([])
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: instance,
    configurable: true,
  })
  const adapter = await instance.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('capture: no WebGPU adapter from Dawn')
  const device = await adapter.requestDevice()
  // Dawn 0.1.x rejects a plain function here, three assigns one unconditionally.
  Object.defineProperty(device, 'onuncapturederror', {
    get: () => null,
    set: () => {},
    configurable: true,
  })

  const canvas = {
    width,
    height,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getContext: () => null,
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
    }),
  }

  let swapTexture: GPUTexture | null = null
  const context = {
    configure() {},
    unconfigure() {},
    getCurrentTexture() {
      swapTexture ??= device.createTexture({
        size: [width, height, 1],
        format: 'bgra8unorm',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.TEXTURE_BINDING,
      })
      return swapTexture
    },
  }

  const renderer = new WebGPURenderer({
    canvas,
    device,
    context,
    antialias: true,
    alpha: false,
  } as never)
  // Falling back to a WebGL backend inside Node would silently produce garbage.
  ;(renderer as unknown as { _getFallback: unknown })._getFallback = null
  renderer.setSize(width, height, false)
  await renderer.init()

  const target = new RenderTarget(width, height, {
    depthBuffer: true,
    samples: 4,
  })
  target.texture.colorSpace = SRGBColorSpace

  return {
    renderer,
    async capture(render) {
      renderer.setRenderTarget(target)
      await render()
      renderer.setRenderTarget(null)
      const pixels = await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        width,
        height,
      )
      return new Uint8Array(pixels.buffer)
    },
    async timeFrame(render) {
      renderer.setRenderTarget(target)
      await render()
      renderer.setRenderTarget(null)
      await device.queue.onSubmittedWorkDone()
    },
    dispose() {
      target.dispose()
      renderer.dispose()
      device.destroy()
      dawn.destroy(instance)
    },
  }
}
