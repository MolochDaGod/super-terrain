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
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { smaa } from 'three/addons/tsl/display/SMAANode.js'
import type { TerrainRenderMode } from '../renderModes'
import { volumetricValleyFog } from './volumetricValleyFog'

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
  const saturated = mix(vec3(grey), contrasted, float(1.11))
  // Gentle photographic split tone: open-sky shadows retain a cool slate
  // cast while direct low-sun highlights move toward warm stone. This replaces
  // the previous uniform brown wash without shifting neutral midtones.
  const split = smoothstep(0.16, 0.72, grey)
  const toned = saturated.mul(mix(
    vec3(0.94, 0.99, 1.055),
    vec3(1.06, 1.01, 0.94),
    split,
  ))
  const lifted = toned.add(smoothstep(0.12, 0, grey).mul(0.01))
  const lens = uv().sub(0.5)
  const radius = lens.x.mul(lens.x)
    .mul(0.82)
    .add(lens.y.mul(lens.y).mul(1.08))
  const vignette = smoothstep(0.16, 0.52, radius)
  const vignetted = lifted.mul(mix(float(1), float(0.79), vignette))
  return vec4(vignetted.clamp(0, 1), colour.a)
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
  const depth = scenePass.getTextureNode('depth')
  const fogged = volumetricValleyFog(colour, depth, camera)
  const glow = bloom(fogged, 0.21, 0.78, 1.5)
  // MSAA resolves triangle edges in the scene pass, but the tone curve,
  // high-frequency normal detail and bloom can recreate display-space stair
  // steps afterwards. SMAA runs on the final linear HDR image before the
  // colour transform and catches those residual edges without temporal blur.
  const antialiased = smaa(fogged.add(glow))
  const graded = renderOutput(
    antialiased,
    renderer.toneMapping,
    renderer.outputColorSpace,
  )
  const pipeline = new RenderPipeline(renderer, grade(graded))
  pipeline.outputColorTransform = false

  return {
    pipeline,
    warmup: () => warmRenderPipeline(renderer, scenePass, pipeline, glow),
    dispose() {
      pipeline.dispose()
      ;(glow as unknown as InternalBloomNode).dispose()
      ;(antialiased as unknown as { dispose(): void }).dispose()
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
    // Bloom creates five blur texture nodes with a null value and fills them
    // during its first updateBefore(). Our warm-up deliberately runs before
    // the first submitted frame, so give those bindings a valid format-matched
    // source for compilation. Runtime immediately replaces it with the proper
    // bright/horizontal target for each pass.
    for (const material of internalBloom._separableBlurMaterials) {
      const colorTexture = (material as Material & {
        colorTexture?: { value?: unknown }
      }).colorTexture
      if (colorTexture && !colorTexture.value) {
        colorTexture.value = internalBloom._renderTargetBright.texture
      }
    }
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
