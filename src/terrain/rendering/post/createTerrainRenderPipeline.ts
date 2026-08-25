import { QuadMesh, RenderPipeline } from 'three/webgpu'
import type {
  Camera,
  Material,
  Object3D,
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
  textureSize,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { smaa } from 'three/addons/tsl/display/SMAANode.js'
import type { TerrainRenderMode } from '../renderModes'
import { treeAtmosphericHaze } from '../../../tree/rendering/treeAtmosphericHaze'
import { volumetricValleyFog } from './volumetricValleyFog'

export type PostLook = 'terrain' | 'tree'

export interface TerrainRenderPipeline {
  pipeline: RenderPipeline
  /** Prepares the scene and every internal fullscreen pipeline asynchronously. */
  warmup(): Promise<void>
  /** Compiles a staged object against this pass's real attachments and scene lights. */
  warmupObject(object: Object3D): Promise<void>
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
const terrainGrade = /*@__PURE__*/ Fn(([colour]: [any]) => {
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

/**
 * A restrained foliage grade. The terrain look deliberately pushes warm rock
 * and saturated alpine greens; using it on an isolated oak made the canopy
 * radioactive. This keeps AgX's highlight headroom, adds a photographic toe,
 * cools open-sky shade and warms only the upper values.
 */
const treeGrade = /*@__PURE__*/ Fn(([colour]: [any]) => {
  const rgb = colour.rgb
  const curved = rgb.mul(rgb).mul(3).sub(rgb.mul(rgb).mul(rgb).mul(2))
  const contrasted = mix(curved, rgb, float(0.47))
  const grey = luminance(contrasted)
  // Restore a little healthy daylight chroma after AgX without returning to
  // the original electric-green foliage. Source albedo remains responsible
  // for the palette; this is only a gentle display-referred recovery.
  const saturated = mix(vec3(grey), contrasted, float(1.065))
  const split = smoothstep(0.14, 0.76, grey)
  const toned = saturated.mul(mix(
    vec3(0.982, 0.998, 1.018),
    vec3(1.04, 1.012, 0.972),
    split,
  ))
  const lifted = toned.add(smoothstep(0.1, 0, grey).mul(0.008))
  const lens = uv().sub(0.5)
  const radius = lens.x.mul(lens.x)
    .mul(0.82)
    .add(lens.y.mul(lens.y).mul(1.08))
  const vignette = smoothstep(0.18, 0.55, radius)
  const vignetted = lifted.mul(mix(float(1), float(0.88), vignette))
  return vec4(vignetted.clamp(0, 1), colour.a)
})

/**
 * A small HDR glow folded into the final grading quad.
 *
 * Three's full BloomNode is excellent for the terrain hero render, but it owns
 * a bright pass, ten blur passes and a composite. An asset editor does not need
 * that machinery. Twelve sparse HDR taps make a restrained sun/sky halo in the
 * same pass that already performs tone mapping and grading, so there are no
 * extra render targets and no multi-pass bloom shader warm-up.
 */
const cheapTreeBloom = /*@__PURE__*/ Fn(([source]: [any]) => {
  const centre = uv().toVar('treeBloomUv')
  const pixel = vec2(1).div(vec2(textureSize(source) as any))
    .toVar('treeBloomPixel')
  const glow = vec3(0).toVar('treeBloomGlow')
  const offsets = [
    [-3, 0], [3, 0], [0, -3], [0, 3],
    [-6, -6], [6, -6], [-6, 6], [6, 6],
    [-11, 0], [11, 0], [0, -11], [0, 11],
  ] as const
  for (const [x, y] of offsets) {
    const sample = source.sample(
      centre.add(pixel.mul(vec2(x, y))).clamp(0.001, 0.999),
    ).rgb
    const bright = smoothstep(0.86, 1.42, luminance(sample))
    glow.addAssign(sample.mul(bright))
  }
  return glow.mul(float(0.0115))
})

export function createTerrainRenderPipeline(
  renderer: Renderer,
  scene: Scene,
  camera: Camera,
  mode: TerrainRenderMode,
  effects = true,
  look: PostLook = 'terrain',
): TerrainRenderPipeline {
  const scenePass = pass(scene, camera)

  if (mode !== 'full' || !effects) {
    const pipeline = new RenderPipeline(renderer, scenePass)
    const warmup = memoizeWarmup(
      () => warmRenderPipeline(renderer, scenePass, pipeline),
    )
    return {
      pipeline,
      warmup,
      warmupObject: async (object) => {
        await warmup()
        await warmSceneObject(renderer, scenePass, object, scene, camera)
      },
      dispose: () => pipeline.dispose(),
    }
  }

  // Terrain-scale occlusion is stored in each compiled section. The scene pass
  // therefore needs only its HDR colour attachment: no per-frame normal MRT,
  // no 48-tap screen kernel and no denoise pass for unchanged geometry.
  const colour = scenePass.getTextureNode('output')
  const depth = scenePass.getTextureNode('depth')
  if (look === 'tree') {
    const hazed = treeAtmosphericHaze(colour, depth, camera)
    const glowing = hazed.rgb.add(cheapTreeBloom(colour))
    const graded = renderOutput(
      vec4(glowing, hazed.a),
      renderer.toneMapping,
      renderer.outputColorSpace,
    )
    const pipeline = new RenderPipeline(renderer, treeGrade(graded))
    pipeline.outputColorTransform = false
    const warmup = memoizeWarmup(
      () => warmRenderPipeline(renderer, scenePass, pipeline),
    )
    return {
      pipeline,
      warmup,
      warmupObject: async (object) => {
        await warmup()
        await warmSceneObject(renderer, scenePass, object, scene, camera)
      },
      dispose: () => pipeline.dispose(),
    }
  }

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
  const pipeline = new RenderPipeline(renderer, terrainGrade(graded))
  pipeline.outputColorTransform = false
  const warmup = memoizeWarmup(
    () => warmRenderPipeline(renderer, scenePass, pipeline, glow),
  )

  return {
    pipeline,
    warmup,
    warmupObject: async (object) => {
      await warmup()
      await warmSceneObject(renderer, scenePass, object, scene, camera)
    },
    dispose() {
      pipeline.dispose()
      ;(glow as unknown as InternalBloomNode).dispose()
      ;(antialiased as unknown as { dispose(): void }).dispose()
    },
  }
}

function memoizeWarmup(warm: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    pending ??= warm().catch((error: unknown) => {
      // A transient device/pipeline failure must remain retryable.
      pending = undefined
      throw error
    })
    return pending
  }
}

async function warmSceneObject(
  renderer: Renderer,
  scenePass: any,
  object: Object3D,
  scene: Scene,
  camera: Camera,
): Promise<void> {
  const previousTarget = renderer.getRenderTarget()
  const previousMrt = renderer.getMRT()
  const renderables: Object3D[] = []
  object.updateMatrixWorld(true)
  object.traverseVisible((candidate) => {
    if ('material' in candidate && 'geometry' in candidate) renderables.push(candidate)
  })
  let compiling: Promise<unknown>
  try {
    // Match the exact half-float, multisampled attachment used by the scene
    // pass. Compiling against the swap chain can produce a different pipeline
    // key and simply move the hitch to the first visible post-processed frame.
    renderer.setRenderTarget(scenePass.renderTarget)
    renderer.setMRT(scenePass.getMRT())
    // Renderer.compileAsync captures its render context and work list before
    // yielding. Starting independent renderables together lets WebGPU compile
    // their pipelines and prepare their buffers concurrently; a group compile
    // deliberately awaits every object in series and made eight frond variants
    // cost eight times one variant on every staged tree.
    compiling = Promise.all(
      renderables.map((renderable) => renderer.compileAsync(renderable, camera, scene)),
    )
  } finally {
    // compileAsync captures the render context and work list synchronously,
    // then yields while node graphs and GPU pipelines build. Restore the live
    // renderer immediately so the previous stable frame can keep rendering.
    renderer.setRenderTarget(previousTarget)
    renderer.setMRT(previousMrt)
  }
  await compiling
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
