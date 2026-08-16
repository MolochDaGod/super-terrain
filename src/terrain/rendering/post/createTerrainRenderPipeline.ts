import { RenderPipeline } from 'three/webgpu'
import type { Camera, Renderer, Scene } from 'three/webgpu'
import {
  Fn,
  float,
  luminance,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  smoothstep,
  vec3,
  vec4,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { ao } from 'three/addons/tsl/display/GTAONode.js'
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import type { TerrainRenderMode } from '../renderModes'

export interface TerrainRenderPipeline {
  pipeline: RenderPipeline
  dispose(): void
}

/**
 * Output chain.
 *
 * Tone mapping and the sRGB transfer are applied by the pipeline's output
 * transform, so the scene renders in linear HDR and the highlight roll-off does
 * real work instead of clipping.
 *
 * `full` adds two passes the material cannot do for itself:
 *
 *   - **GTAO**, which darkens gullies, crevices and the ground under an
 *     overhang. Cavity occlusion baked into the material only knows about the
 *     micro-relief at that pixel; screen-space AO is what puts a whole ravine
 *     into shade.
 *   - **A narrow bloom**, so sunlit snow and rock edges read as bright rather
 *     than merely light-coloured.
 */
/**
 * Display-space grade. AgX deliberately lands everything in the midtones so
 * nothing clips; that protects the sky but leaves the frame flat, so the
 * contrast and the saturation that the curve gave up are put back here, after
 * tone mapping, where an S-curve cannot reintroduce clipping in the scene
 * referred data.
 */
const grade = /*@__PURE__*/ Fn(([colour]: [any]) => {
  const rgb = colour.rgb
  // Pivoted S-curve: darks fall away, highlights hold.
  const contrasted = mix(
    rgb.mul(rgb).mul(3).sub(rgb.mul(rgb).mul(rgb).mul(2)),
    rgb,
    float(0.38),
  )
  const grey = luminance(contrasted)
  const saturated = mix(vec3(grey), contrasted, float(1.14))
  // Lift the deepest shadows a touch so they read as air, not as holes.
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
    return { pipeline, dispose: () => pipeline.dispose() }
  }

  scenePass.setMRT(mrt({ output, normal: normalView }))
  const colour = scenePass.getTextureNode('output')
  const depth = scenePass.getTextureNode('depth')
  const normals = scenePass.getTextureNode('normal')
  const occlusion = ao(depth, normals, camera)
  // Radius is in world units: on a landscape, sub-metre sampling finds nothing
  // to occlude with. Gullies and the base of a face are metres across, so the
  // radius has to be too.
  occlusion.radius.value = 7
  occlusion.thickness.value = 4
  occlusion.distanceExponent.value = 1.5
  occlusion.distanceFallOff.value = 0.7
  occlusion.scale.value = 1.5
  occlusion.samples.value = 24

  // GTAO dithers its sample directions with a fixed screen-space pattern; on a
  // large smooth surface that pattern is plainly visible as a dot lattice.
  // Without temporal accumulation the only fix is an edge-aware denoise.
  const smoothedOcclusion = denoise(
    occlusion.getTextureNode(),
    depth,
    normals,
    camera,
  )

  const occluded = colour.mul(vec4(vec3((smoothedOcclusion as any).r), 1))
  const glow = bloom(occluded, 0.09, 0.75, 1.5)

  // Ridge silhouettes against a bright sky are the worst case for aliasing, and
  // MSAA is not guaranteed on the WebGPU path, so edges are resolved in post.
  // FXAA has to see tone-mapped, display-referred pixels to find those edges,
  // which means doing the output transform here rather than letting the
  // pipeline apply it afterwards.
  const graded = renderOutput(
    occluded.add(glow),
    renderer.toneMapping,
    renderer.outputColorSpace,
  )
  const pipeline = new RenderPipeline(renderer, fxaa(grade(graded)))
  pipeline.outputColorTransform = false

  return {
    pipeline,
    dispose() {
      pipeline.dispose()
    },
  }
}
