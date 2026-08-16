import { QuadMesh, RenderPipeline } from 'three/webgpu'
import type {
  Camera,
  Material,
  RenderTarget,
  Renderer,
  Scene,
} from 'three/webgpu'
import {
  Fn,
  float,
  luminance,
  mix,
  pass,
  renderOutput,
  smoothstep,
  vec3,
  vec4,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import type { TerrainRenderMode } from '../renderModes'

export interface TerrainRenderPipeline {
  pipeline: RenderPipeline
  /** Prepares the scene and every internal fullscreen pipeline asynchronously. */
  warmup(): Promise<void>
  dispose(): void
}

interface InternalRenderPipeline extends RenderPipeline {
  _update(): void
  _quadMesh: QuadMesh
}

interface InternalBloomNode {
  _renderTargetBright: RenderTarget
  _highPassFilterMaterial: Material | null
  _separableBlurMaterials: Material[]
  _compositeMaterial: Material | null
  dispose(): void
}

/**
 * Display-space grade. AgX deliberately lands everything in the midtones so
 * nothing clips; that protects the sky but leaves the frame flat, so the
 * contrast and saturation that the curve gave up are put back after tone
 * mapping, where an S-curve cannot reintroduce scene-referred clipping.
 */
const grade = /*@__PURE__*/ Fn(([colour]: [any]) => {
  const rgb = colour.rgb
  const contrasted = mix(
    rgb.mul(rgb).mul(3).sub(rgb.mul(rgb).mul(rgb).mul(2)),
    rgb,
    float(0.38),
  )
  const grey = luminance(contrasted)
  const saturated = mix(vec3(grey), contrasted, float(1.14))
  const lifted = saturated.add(smoothstep(0.12, 0, grey).mul(0.012))
  return vec4(lifted.clamp(0, 1), colour.a)
})

export function createTerrainRenderPipeline(
  renderer: Renderer,
  scene: Scene,
  camera: Camera,
  mode: TerrainRenderMode,
  effects = true,
): TerrainRenderPipeline {
  const scenePass = pass(scene, camera)

  if (mode !== 'full' || !effects) {
    const pipeline = new RenderPipeline(renderer, scenePass)
    return {
      pipeline,
      warmup: () => warmRenderPipeline(renderer, scenePass, pipeline),
      dispose: () => pipeline.dispose(),
    }
  }

  // Terrain-scale occlusion is stored in each compiled section. The scene pass
  // therefore needs only its HDR colour attachment: no per-frame normal MRT,
  // no 48-tap screen kernel and no denoise pass for unchanged geometry.
  const colour = scenePass.getTextureNode('output')
  const glow = bloom(colour, 0.09, 0.75, 1.5)
  const graded = renderOutput(
    colour.add(glow),
    renderer.toneMapping,
    renderer.outputColorSpace,
  )
  // The renderer and this PassNode use 4x MSAA. A second FXAA pass here would
  // re-filter already-resolved edges, softening the centimetre relief and
  // forcing an otherwise unnecessary full-resolution RTT.
  const pipeline = new RenderPipeline(renderer, grade(graded))
  pipeline.outputColorTransform = false

  return {
    pipeline,
    warmup: () => warmRenderPipeline(renderer, scenePass, pipeline, glow),
    dispose() {
      pipeline.dispose()
      ;(glow as unknown as InternalBloomNode).dispose()
    },
  }
}

async function warmRenderPipeline(
  renderer: Renderer,
  scenePass: any,
  pipeline: RenderPipeline,
  bloomNode?: unknown,
): Promise<void> {
  // PassNode knows its real attachment formats and sample count, which makes
  // this more complete than compiling the scene against the swap chain.
  await scenePass.compileAsync(renderer)

  const internalPipeline = pipeline as InternalRenderPipeline
  internalPipeline._update()
  await compileQuad(renderer, internalPipeline._quadMesh)

  // Bloom owns a high-pass, five separable blur variants and a composite quad.
  // Its setup runs while the final quad is built; compile every resulting
  // material now, against the same half-float attachment used at runtime.
  const internalBloom = bloomNode as InternalBloomNode | undefined
  if (internalBloom?._highPassFilterMaterial) {
    const materials = [
      internalBloom._highPassFilterMaterial,
      ...internalBloom._separableBlurMaterials,
      internalBloom._compositeMaterial,
    ].filter((material): material is Material => material !== null)
    for (const material of materials) {
      await compileMaterialQuad(
        renderer,
        material,
        internalBloom._renderTargetBright,
      )
    }
  }
}

async function compileMaterialQuad(
  renderer: Renderer,
  material: Material,
  renderTarget: RenderTarget,
): Promise<void> {
  const quad = new QuadMesh(material)
  await compileQuad(renderer, quad, renderTarget)
}

async function compileQuad(
  renderer: Renderer,
  quad: QuadMesh,
  renderTarget: RenderTarget | null = null,
): Promise<void> {
  const previousTarget = renderer.getRenderTarget()
  const previousMrt = renderer.getMRT()
  try {
    renderer.setMRT(null)
    renderer.setRenderTarget(renderTarget)
    await renderer.compileAsync(quad, quad.camera)
  } finally {
    renderer.setRenderTarget(previousTarget)
    renderer.setMRT(previousMrt)
  }
}
