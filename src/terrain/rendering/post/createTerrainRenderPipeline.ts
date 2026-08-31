import { QuadMesh, RenderPipeline, Vector3 } from 'three/webgpu'
import type { DirectionalLight } from 'three/webgpu'
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
  max,
  min,
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
import { trackGpuCompilation } from '../gpuResourceRetirement'
import {
  FOREST_HAZE,
  LANDSCAPE_HAZE,
  treeAtmosphericHaze,
} from '../../../tree/rendering/treeAtmosphericHaze'
import { volumetricValleyFog } from './volumetricValleyFog'
import { SunDepthMap } from './sunDepthMap'
import {
  createGodrayControls,
  setGodraySun,
  volumetricGodrays,
  type GodrayControls,
} from './volumetricGodrays'

/**
 * Which post chain the frame goes through.
 *
 * `terrain` is the original landscape stack — valley fog, pyramid bloom, SMAA.
 * `tree` is the forest interior's — analytic haze, sun shafts against a depth
 * map, a tight screen-space glow, and a grade with a lifted toe.
 * `wooded-landscape` is the forest chain over an open world, and is not the
 * same thing as either: it keeps the haze, the shafts and the grade, and swaps
 * the two parts of the tree chain whose constants are interior-scale — the haze
 * profile, which stops integrating at a hundred and fifty metres, and the glow,
 * whose eleven-pixel kernel draws a hard halo along a ridge silhouette instead
 * of a bloom.
 */
export type PostLook = 'terrain' | 'tree' | 'wooded-landscape'

export interface TerrainRenderPipeline {
  pipeline: RenderPipeline
  /** Prepares the scene and every internal fullscreen pipeline asynchronously. */
  warmup(): Promise<void>
  /** Compiles a staged object against this pass's real attachments and scene lights. */
  warmupObject(object: Object3D): Promise<void>
  /**
   * Per-frame work the post chain needs done before it runs — currently the
   * sun depth map the light shafts march against. Absent on looks that have
   * no such effect.
   */
  updateEffects?: () => void
  /** Live knobs for the light shafts, when the look has them. */
  godrayControls?: GodrayControls
  dispose(): void
}

/** The scene's key light: the one directional light that casts shadows. */
function findShadowSun(scene: Scene): DirectionalLight | null {
  let found: DirectionalLight | null = null
  scene.traverse((object) => {
    const light = object as DirectionalLight
    if (found || !light.isDirectionalLight || !light.castShadow) return
    found = light
  })
  return found
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
 * The forest-interior grade.
 *
 * A photograph taken inside a stand is not a landscape with trees in it, and
 * the two want opposite things from a curve. The landscape grade protects a
 * sky several stops above the ground and keeps shade cool and blue, because
 * open shade *is* lit by blue sky. Under a canopy almost nothing is: the fill
 * has been filtered through leaves or bounced off brown litter, so the deepest
 * parts of a forest reference are warm and dark, its greens are the most
 * saturated thing in frame, and the few sky slivers are simply blown.
 *
 * So this pushes contrast hard, keeps a small toe lift so the darks stay
 * readable rather than clipping to black, warms the shadows instead of cooling
 * them, and recovers chroma preferentially where the frame is already green —
 * a flat saturation lift would take the litter and the bark along with it and
 * turn the floor orange.
 */
const treeGrade = /*@__PURE__*/ Fn(([colour]: [any]) => {
  const rgb = colour.rgb
  // Contrast on luminance, not per channel.
  //
  // A per-channel S-curve exaggerates whatever imbalance a pixel already has:
  // it lifts the strong channel and crushes the weak one, so every colour
  // slides toward the nearest primary as contrast goes up. On a forest frame
  // that meant blue was pushed to roughly half of red across bark, litter and
  // canopy alike, and the whole image came back khaki however the lights were
  // balanced. Scaling the triplet by the curve's effect on its own luminance
  // gives the same contrast and leaves the hue where the lighting put it.
  const grey = luminance(rgb).max(float(0.0001)).toVar('treeGradeLuma')
  const curved = grey.mul(grey).mul(3).sub(grey.mul(grey).mul(grey).mul(2))
  // Only lightly curved. A full smoothstep is a strong S, and the subject here
  // is a scene whose interesting half already sits in the bottom two stops:
  // at 0.26 it drove almost every trunk and every square metre of litter into
  // the toe, which is how a forest that is merely dim turns into a silhouette.
  const contrastGrey = mix(curved, grey, float(0.62))
  const contrasted = rgb.mul(contrastGrey.div(grey)) as any

  // Chroma recovery, weighted toward the greens. `leafiness` is how much of
  // this pixel's colour is green over the mean of the other two primaries,
  // which is high on moss and foliage and near zero on bark, litter and sky.
  const leafiness = smoothstep(
    0.0,
    0.16,
    contrasted.g.sub(contrasted.r.add(contrasted.b).mul(0.5)),
  )
  const saturation = mix(float(1.05), float(1.2), leafiness)
  const saturated = mix(vec3(contrastGrey), contrasted, saturation)

  // Split tone. Both ends are warm — the cool end of a forest interior is the
  // canopy light itself, not its shade — but the shadows carry the litter's
  // red and the highlights roll toward a bleached cream as they clip.
  const split = smoothstep(0.05, 0.62, contrastGrey)
  const toned = saturated.mul(mix(
    vec3(1.012, 0.997, 0.978),
    vec3(1.022, 1.0, 0.962),
    split,
  ))
  // A small toe lift. Photographic blacks are never zero, and an interior with
  // clipped shadows loses the trunk separation that carries the depth.
  // A real toe, not a token one. Shade under a canopy is full of scattered
  // green light, so its floor is a long way above zero — and separation
  // between overlapping dark trunks is the entire depth cue in this frame.
  const lifted = toned.add(smoothstep(0.3, 0, contrastGrey).mul(0.05))

  // A deeper vignette than the landscape's. A closed canopy genuinely is
  // darker at the frame edge, and it is what keeps the eye in the clearing.
  const lens = uv().sub(0.5)
  const radius = lens.x.mul(lens.x)
    .mul(0.82)
    .add(lens.y.mul(lens.y).mul(1.08))
  const vignette = smoothstep(0.12, 0.62, radius)
  const vignetted = lifted.mul(mix(float(1), float(0.93), vignette))
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

/**
 * How much brighter than its brightest neighbour a pixel may be before it is
 * treated as an outlier rather than as an image.
 */
const FIREFLY_TOLERANCE = 2.5
/** Luminance below which nothing is ever suppressed. */
const FIREFLY_FLOOR = 0.4

/**
 * Rejects single-pixel HDR outliers before anything downstream amplifies them.
 *
 * The symptom is small extremely bright specks blinking across distant ground,
 * worst where grass is moving in wind. The cause is specular aliasing: once a
 * blade is smaller than a pixel, the highlight lobe is point-sampled, the pixel
 * takes whichever half-vector its one sample happened to land on, and the wind
 * rewrites that answer every frame. One sample can land two orders of magnitude
 * above its neighbours.
 *
 * Three's `BloomNode` is a threshold high-pass followed by a blur pyramid with
 * no outlier rejection of its own, so it takes that one pixel and spreads it
 * into a visible blob — and the blob blinks. Volumetric godrays smear the same
 * pixel into a streak. Both are faithfully amplifying a value that was never
 * an image feature.
 *
 * Narrowing the specular lobe at range, which is the correct fix at the source,
 * reduces this and does not remove it: any sufficiently peaked highlight on any
 * material can still spike a single sample, and the grass is not the only thing
 * in the scene with one. So the outlier is also rejected here, once, where
 * every source passes through.
 *
 * Comparison is against the *neighbourhood*, not against an absolute ceiling,
 * and that distinction is the whole design. A hard luminance clamp cannot tell
 * a firefly from the sun, and dims the sky and the snow to catch a speck. A
 * pixel far brighter than everything touching it is an outlier whatever its
 * absolute value; a pixel in a large bright region has bright neighbours and is
 * left exactly as it is.
 */
const rejectFireflies = /*@__PURE__*/ Fn(([source]: [any]) => {
  const centre = uv().toVar('fireflyUv')
  const pixel = vec2(1).div(vec2(textureSize(source) as any)).toVar('fireflyPixel')
  const here = source.sample(centre).toVar('fireflyHere')
  const brightest = float(0).toVar('fireflyNeighbourhood')
  for (const [x, y] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    brightest.assign(
      max(
        brightest,
        luminance(
          source.sample(
            centre.add(pixel.mul(vec2(x, y))).clamp(0.001, 0.999),
          ).rgb,
        ),
      ),
    )
  }
  const level = luminance(here.rgb)
  const limit = brightest.mul(float(FIREFLY_TOLERANCE)).add(float(FIREFLY_FLOOR))
  // Scaled rather than clipped, so the hue of a suppressed pixel survives and
  // it settles into its surroundings instead of turning grey.
  const scale = min(float(1), limit.div(max(level, float(1e-4))))
  return vec4(here.rgb.mul(scale), here.a)
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
  // Outliers are rejected once, here, before the haze, the godrays and either
  // bloom get a chance to amplify them. See `rejectFireflies`.
  //
  // `sceneColour` stays available because `cheapTreeBloom` gathers its own taps
  // and needs something it can `.sample()`; the haze, the fog and the godrays
  // all read their input as a value, so they get the cleaned one.
  const sceneColour = scenePass.getTextureNode('output')
  const colour = rejectFireflies(sceneColour)
  const depth = scenePass.getTextureNode('depth')
  if (look === 'tree' || look === 'wooded-landscape') {
    const landscape = look === 'wooded-landscape'
    // Shafts are integrated before the bloom so they bloom, which is most of
    // what makes a beam read as light rather than as a grey wedge.
    const sunDepth = new SunDepthMap()
    const godrayControls = createGodrayControls()
    if (landscape) {
      // The shaft medium's ceiling is a height above *sea level*, and its
      // default of twenty-six metres is a forest's: shafts belong in the first
      // few trunk-lengths above the floor. This world's ground starts at about
      // sixty metres and its ridges reach three hundred, so on terrain that
      // default put the entire medium underground and the light shafts — the
      // whole reason this chain was brought over — never appeared at all.
      godrayControls.ceiling.value = 340
      // Thinner to match. The same coefficient over a column ten times deeper
      // integrates to ten times the optical depth, which is a white-out rather
      // than a shaft.
      godrayControls.density.value = 0.00022
    }
    const hazed = treeAtmosphericHaze(
      colour,
      depth,
      camera,
      landscape ? LANDSCAPE_HAZE : FOREST_HAZE,
    )
    const shafted = volumetricGodrays(hazed, depth, camera, sunDepth, godrayControls)
    // A pyramid bloom over open country, a screen kernel inside a stand.
    //
    // `cheapTreeBloom` reaches eleven pixels. Against a forest's small bright
    // sky gaps that is a glow; against a landscape's whole bright sky it is a
    // hard white outline traced along every ridge, which is the opposite of
    // soft. The pyramid costs more and is the only thing that blooms a large
    // bright area without drawing its edge.
    const wide = landscape ? bloom(shafted, 0.13, 0.88, 1.06) : null
    const glowing = wide
      ? shafted.rgb.add(wide.rgb)
      : shafted.rgb.add(cheapTreeBloom(sceneColour))
    const graded = renderOutput(
      vec4(glowing, shafted.a),
      renderer.toneMapping,
      renderer.outputColorSpace,
    )
    const pipeline = new RenderPipeline(renderer, treeGrade(graded))
    pipeline.outputColorTransform = false
    const warmup = memoizeWarmup(
      () => warmRenderPipeline(renderer, scenePass, pipeline, wide ?? undefined),
    )
    const sunWorld = new Vector3()
    const sunTarget = new Vector3()
    return {
      pipeline,
      warmup,
      godrayControls,
      // Runs before the post chain: the depth map has to describe the frame it
      // is about to light, and the sun has to match the one casting shadows or
      // the shafts point somewhere the shadows do not.
      updateEffects: () => {
        const sun = findShadowSun(scene)
        if (!sun) return
        sun.getWorldPosition(sunWorld)
        sun.target.getWorldPosition(sunTarget)
        const direction = sunWorld.sub(sunTarget).normalize()
        setGodraySun(godrayControls, direction, sun.color, sun.intensity)
        sunDepth.update(renderer, scene, camera, direction)
      },
      warmupObject: async (object) => {
        await warmup()
        await warmSceneObject(renderer, scenePass, object, scene, camera)
      },
      dispose: () => {
        sunDepth.dispose()
        pipeline.dispose()
      },
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
  // A compile keeps using the geometries and materials it captured until it
  // resolves, so deferred disposal has to wait for it. Destroying a buffer
  // that is still in the captured work list puts a dead handle back into the
  // backend's attribute cache and every later frame fails validation.
  return trackGpuCompilation(() => compileSceneObject(
    renderer, scenePass, object, scene, camera,
  ))
}

async function compileSceneObject(
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
  // Warm-up objects are intentionally hidden until compilation completes.
  // `traverseVisible` therefore skipped the exact staged meshes this function
  // exists to prepare and moved every pipeline stall into the reveal frame.
  object.traverse((candidate) => {
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
  return trackGpuCompilation(
    () => compileRenderPipeline(renderer, scenePass, pipeline, bloomNode),
  )
}

async function compileRenderPipeline(
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
