import {
  Loop,
  dot,
  exp,
  float,
  Fn,
  getViewPosition,
  interleavedGradientNoise,
  max,
  mix,
  pow,
  screenCoordinate,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { Color, Vector3, type Camera } from 'three/webgpu'
import type { SunDepthMap } from './sunDepthMap'

/** Marching steps. Enough that the jitter dissolves the banding; few enough to be cheap. */
const STEPS = 32

/**
 * Two balanced hardware-PCF samples. Each comparison bilinearly filters a 2x2
 * depth footprint, giving the march eight softened taps for two instructions.
 */
const PCF_TAPS = [
  [-0.94, 0.34],
  [0.94, -0.34],
] as const

/**
 * Henyey-Greenstein asymmetry. Air scatters strongly forward, which is the
 * entire reason shafts blaze when you look toward the sun and are nearly
 * invisible with it behind you. A symmetric phase gives a uniform haze that
 * reads as fog, not as light.
 */
const FORWARD_SCATTER = 0.76

/**
 * TSL's published types resolve a concrete node type per call, which is
 * unusable for uniforms threaded through a march. The shader graph is checked
 * by the WGSL compiler.
 */
type Node = any

export interface GodrayControls {
  /** float: scattering coefficient of the air, per metre. */
  density: Node
  /** float: overall strength of the effect. */
  intensity: Node
  /** float: height in metres over which the medium thins out. */
  ceiling: Node
  /** vec3: direction toward the sun. */
  sunDirection: Node
  /** vec3: sun colour premultiplied by its intensity. */
  sunColour: Node
  /**
   * float: 1 paints the marched sun visibility instead of the scene.
   *
   * A shaft that fails to appear has two very different causes — the medium is
   * too thin, or the occlusion test is returning "lit" everywhere because the
   * depth comparison is wrong — and they are indistinguishable in a beauty
   * frame. This tells them apart in one capture.
   */
  debug: Node
}

export function createGodrayControls(): GodrayControls {
  return {
    // Scattering coefficient per metre.
    //
    // This was 0.019, which is three orders of magnitude above anything air
    // does and integrated to an optical depth of about 2.5 over the marched
    // range — the medium was denser than cloud. Six ten-thousandths puts the
    // peak in-scatter near a tenth of the sun's own radiance, which reads as
    // shafts rather than as a white-out.
    density: uniform(0.0006) as Node,
    intensity: uniform(1) as Node,
    ceiling: uniform(26) as Node,
    sunDirection: uniform(new Vector3(0, 1, 0)) as Node,
    sunColour: uniform(new Vector3(1, 0.94, 0.82)) as Node,
    debug: uniform(0) as Node,
  }
}

export function setGodraySun(
  controls: GodrayControls,
  direction: Vector3,
  colour: Color,
  intensity: number,
): void {
  controls.sunDirection.value.copy(direction).normalize()
  controls.sunColour.value.set(
    colour.r * intensity,
    colour.g * intensity,
    colour.b * intensity,
  )
}

/**
 * In-scattered sunlight along the view ray, occluded by the sun depth map.
 *
 * This is a volumetric integration, not a radial blur of bright pixels. The
 * difference shows the moment the sun leaves the frame: a radial blur has
 * nothing left to smear and the shafts vanish, while this keeps lighting the
 * air between the camera and the canopy because the integral does not care
 * where the sun is on screen.
 */
export function volumetricGodrays(
  colour: any,
  depthTexture: any,
  camera: Camera,
  sun: SunDepthMap,
  controls: GodrayControls,
): any {
  // The post node runs on a fullscreen quad, so the global camera accessors
  // describe that quad's orthographic camera rather than the one that produced
  // the depth. Bind the scene camera's live matrices explicitly.
  const projectionInverse = uniform(camera.projectionMatrixInverse) as Node
  const cameraWorld = uniform(camera.matrixWorld) as Node
  const sunMatrix = uniform(sun.matrix) as Node
  const sunDepth = texture(sun.target.depthTexture as never) as Node
  const range = float(sun.range)

  return Fn(() => {
    const screenUv = uv().toVar('godrayUv')
    const depth = depthTexture.sample(screenUv).r.toVar('godrayDepth')
    const viewPosition = getViewPosition(screenUv, depth, projectionInverse)
      .toVar('godrayViewPosition')
    const world = cameraWorld.mul(vec4(viewPosition, 1)).xyz.toVar('godrayWorld')
    const eye = cameraWorld.mul(vec4(0, 0, 0, 1)).xyz.toVar('godrayEye')

    const ray = world.sub(eye).toVar('godrayRay')
    // Sky pixels reconstruct at the far plane. Integrating out to it would
    // spread the samples so far apart that the shafts become slices, and there
    // is no occluder out there to shape them anyway.
    const distance = ray.length().min(range).toVar('godrayDistance')
    const direction = ray.normalize().toVar('godrayDirection')
    const stepLength = distance.div(float(STEPS)).toVar('godrayStep')

    // Forward scattering toward the sun.
    const cosTheta = (dot as Node)(direction, controls.sunDirection).toVar('godrayCos')
    const g = float(FORWARD_SCATTER)
    const gg = g.mul(g)
    const phase = gg.oneMinus().div(
      pow(gg.add(1).sub(g.mul(cosTheta).mul(2)).max(1e-4), float(1.5)).mul(12.5663706),
    ).toVar('godrayPhase')

    // A per-pixel offset, so the slices land at different depths in
    // neighbouring pixels and read as noise rather than as concentric shells.
    const jitter = interleavedGradientNoise(screenCoordinate).toVar('godrayJitter')
    const scattered = float(0).toVar('godrayScattered')
    const transmittance = float(1).toVar('godrayTransmittance')
    const visibleSum = float(0).toVar('godrayVisibleSum')

    Loop(STEPS, ({ i }: { i: any }) => {
      const along = float(i).add(jitter).mul(stepLength)
      const sample = eye.add(direction.mul(along)).toVar('godraySample')

      // Project into the sun's map. Outside it, treat the air as lit: the map
      // only covers the near field and a hard edge at its boundary would read
      // as a wall of shadow.
      const clip = sunMatrix.mul(vec4(sample, 1)).toVar('godrayClip')
      const ndc = clip.xyz.div(clip.w.max(1e-5)).toVar('godrayNdc')
      const shadowUv = ndc.xy.mul(0.5).add(0.5).toVar('godrayShadowUv')
      const bounds = step as Node
      const inside = bounds(0, shadowUv.x)
        .mul(bounds(shadowUv.x, 1))
        .mul(bounds(0, shadowUv.y))
        .mul(bounds(shadowUv.y, 1))
      // Two hardware-PCF taps on a rotated axis rather than scalar reads.
      //
      // Each lookup is already a bilinear 2x2 depth comparison, so the pair
      // covers eight texels. That is a smoother footprint than four unfiltered
      // scalar reads while issuing half as many texture instructions.
      //
      // Comparison sampling does not use implicit texture derivatives, so it
      // remains valid inside the fixed-count march.
      const texel = float(1.4).div(float(sun.resolution))
      const lit = float(0).toVar('godrayLit')
      for (const [ox, oy] of PCF_TAPS) {
        const at = shadowUv.add(vec2(ox, oy).mul(texel)).clamp(0.001, 0.999)
        lit.addAssign(sunDepth.sample(at).compare(ndc.z.sub(0.0016)))
      }
      const visible = lit
        .mul(float(1 / PCF_TAPS.length))
        .mul(inside)
        .add(inside.oneMinus())

      // Thicker near the floor, thinning with height, which is where the
      // moisture that scatters actually sits.
      const densityAt = controls.density
        .mul((smoothstep as Node)(controls.ceiling, float(0), sample.y).mul(0.85).add(0.15))
      const sigma = densityAt.mul(stepLength)
      visibleSum.addAssign(visible)
      scattered.addAssign(visible.mul(sigma).mul(transmittance))
      transmittance.mulAssign(exp(sigma.negate()))
    })

    // No 4π here. The Henyey-Greenstein phase is already normalised so that it
    // integrates to one over the sphere; multiplying by the sphere's solid
    // angle again inflated every shaft by twelve and a half, which on top of
    // the density error is why looking toward the sun turned half the frame
    // white.
    const shafts = (controls.sunColour as Node)
      .mul(scattered.min(float(0.35)))
      .mul(phase)
      .mul(controls.intensity)
    const lit = vec4(colour.rgb.add((max as Node)(shafts, vec3(0))), colour.a)
    const probe = vec4(vec3(visibleSum.mul(float(1 / STEPS))), colour.a)
    return (mix as Node)(lit, probe, controls.debug)
  })()
}

export const GODRAY_STEPS = STEPS
