import {
  BoxGeometry,
  Mesh,
  PerspectiveCamera,
  Scene,
  WGSLNodeBuilder,
} from 'three/webgpu'
import { context } from 'three/tsl'

/**
 * Compiles a terrain material to WGSL off-device and measures what it costs.
 *
 * This exists because the two cheap checks that look like they cover this one
 * do not. TypeScript sees `any` for every TSL node and catches nothing. And a
 * test that merely builds the node graph catches nothing either, because `Fn`
 * bodies are lazy: `Fn(() => …)()` returns an unexpanded call node and the code
 * inside never runs until a real NodeBuilder walks it. Only this does that.
 *
 * The numbers matter as much as the compile. The full terrain material is an
 * outlier — dozens of Perlin evaluations per fragment before lighting — and at
 * that size the failure mode of adding to it is not a few lost frames. It is
 * crossing a register or compile-time threshold and falling off a cliff, and
 * the cliff is invisible in the diff that causes it.
 */
export interface ShaderCost {
  wgsl: string
  /** Lines in the whole emitted fragment module, helpers included. */
  totalLines: number
  /** Lines in the fragment entry point itself. */
  mainLines: number
  /**
   * Call sites of MaterialX Perlin noise in the emitted code.
   *
   * The dominant cost by a wide margin: each is a full gradient noise with
   * several integer hashes and a trilinear blend, worth on the order of a
   * hundred ALU. Everything else in this material is rounding error beside the
   * count of these, which is why it gets its own budget.
   */
  perlinCallSites: number
}

/** A renderer stub carrying only what `WGSLNodeBuilder` actually reads. */
function stubRenderer(): any {
  return {
    backend: {
      getDrawingBufferSize: () => ({ x: 1, y: 1 }),
      utils: {
        getTextureSampleData: () => ({
          samples: 1,
          primarySamples: 1,
          isMSAA: false,
        }),
      },
    },
    hasFeature: () => false,
    getRenderTarget: () => null,
    getMRT: () => null,
    nodes: { getForRender: () => ({}) },
    library: { fromMaterial: (material: any) => material },
    shadowMap: { enabled: false },
    lighting: { enabled: false },
    contextNode: context(),
    toneMapping: 0,
    outputColorSpace: 'srgb',
    currentColorSpace: 'srgb',
    isDeferredRenderer: false,
    logarithmicDepthBuffer: false,
    alpha: true,
    _nodes: {},
  }
}

export function measureShaderCost(material: any): ShaderCost {
  const mesh = new Mesh(new BoxGeometry(), material)
  const scene = new Scene()
  scene.add(mesh)

  const builder: any = new WGSLNodeBuilder(mesh, stubRenderer())
  builder.material = material
  builder.scene = scene
  builder.geometry = mesh.geometry
  builder.camera = new PerspectiveCamera()
  builder.build()

  const wgsl: string = builder.fragmentShader ?? ''
  const mainAt = wgsl.indexOf('fn main(')
  const main = mainAt >= 0 ? wgsl.slice(mainAt) : wgsl
  return {
    wgsl,
    totalLines: wgsl.split('\n').length,
    mainLines: main.split('\n').length,
    perlinCallSites: (wgsl.match(/mx_perlin_noise_float_\d+\s*\(/g) ?? []).length,
  }
}
