import {
  Loop,
  clamp,
  dot,
  exp,
  float,
  Fn,
  getViewPosition,
  interleavedGradientNoise,
  mix,
  pow,
  screenCoordinate,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import type { Camera } from 'three/webgpu'
import { SUN_DIRECTION } from '../full/atmosphere'

/**
 * Depth-aware low cloud integrated along the visible camera ray.
 *
 * This is deliberately a post volume rather than transparent proxy geometry.
 * Every sample lies between the camera and the scene depth reconstructed for
 * that pixel, so terrain actually occludes the fog and there is no box, plane,
 * or sphere silhouette to leak over a ridge. Ten jittered samples are enough
 * for a slowly varying kilometre-scale medium and preserve the 30 fps budget.
 */
export function volumetricValleyFog(
  colour: any,
  depthTexture: any,
  camera: Camera,
): any {
  // This node is evaluated by a fullscreen QuadMesh. The global camera TSL
  // accessors therefore point at that quad's orthographic camera, not the
  // perspective camera that produced `depthTexture`. Bind the scene camera's
  // live matrix objects explicitly, as Three's GTAO/SSR nodes do.
  const sceneProjectionMatrixInverse = uniform(camera.projectionMatrixInverse)
  const sceneCameraWorldMatrix = uniform(camera.matrixWorld)

  return Fn(() => {
    const screenUv = uv().toVar('valleyFogUv')
    const depth = depthTexture.sample(screenUv).r.toVar('valleyFogDepth')
    const viewPosition = getViewPosition(
      screenUv,
      depth,
      sceneProjectionMatrixInverse,
    ).toVar('valleyFogViewPosition')
    const worldPosition = sceneCameraWorldMatrix
      .mul(vec4(viewPosition, 1))
      .xyz
      .toVar('valleyFogWorldPosition')
    const sceneCameraPosition = sceneCameraWorldMatrix
      .mul(vec4(0, 0, 0, 1))
      .xyz
      .toVar('valleyFogCameraPosition')
    const fullRay = worldPosition
      .sub(sceneCameraPosition)
      .toVar('valleyFogFullRay')
    // Sky pixels reconstruct at the camera far plane. There is no useful fog
    // beyond the editable valley, so cap the integration before that enormous
    // distance turns the ten samples into visibly separated slices.
    const distance = fullRay.length().min(1_650).toVar('valleyFogDistance')
    const direction = fullRay.normalize().toVar('valleyFogDirection')
    const stepLength = distance.div(10).toVar('valleyFogStepLength')
    const jitter = interleavedGradientNoise(screenCoordinate)
      .toVar('valleyFogJitter')
    const opticalDepth = float(0).toVar('valleyFogOpticalDepth')
    const scattered = vec3(0).toVar('valleyFogScattered')
    const drift = time.mul(0.018)

    Loop(10, ({ i }) => {
      const along = float(i)
        .add(jitter)
        .add(0.35)
        .mul(stepLength)
      const sample = sceneCameraPosition
        .add(direction.mul(along))
        .toVar('valleyFogSample')

      // A very broad ellipsoid keeps the medium in the authored basin while a
      // generous fade makes the boundary impossible to read as a volume proxy.
      const basinRadius = sample.x.sub(330).div(830)
        .mul(sample.x.sub(330).div(830))
        .add(
          sample.z.sub(220).div(720)
            .mul(sample.z.sub(220).div(720)),
        )
      const basin = smoothstep(0.48, 1.08, basinRadius).oneMinus()
      const behindForebank = smoothstep(70, 190, sample.z)
      const aboveFloor = smoothstep(-28, 8, sample.y)
      const belowCeiling = smoothstep(34, 82, sample.y).oneMinus()

      // Two broad cloud banks occupy the side valleys behind the landmark.
      // The very low background density keeps the foreground air clear; the
      // banks, rather than a global multiplier, are where visible body lives.
      const leftBankDistance = sample.x.sub(500).div(230)
        .mul(sample.x.sub(500).div(230))
        .add(
          sample.z.sub(285).div(205)
            .mul(sample.z.sub(285).div(205)),
        )
      const rightBankDistance = sample.x.sub(165).div(220)
        .mul(sample.x.sub(165).div(220))
        .add(
          sample.z.sub(330).div(230)
            .mul(sample.z.sub(330).div(230)),
        )
      const bankStrength = smoothstep(0.25, 1.08, leftBankDistance)
        .oneMinus()
        .add(smoothstep(0.25, 1.08, rightBankDistance).oneMinus())
        .clamp(0, 1)

      // Two long, folded wave trains make banks and clear slots instead of a
      // uniform grey wash. Their wavelength is tens of metres, safely above
      // the jittered step spacing at the distances where the layer is visible.
      const folded = sin(
        sample.x.mul(0.014)
          .add(sin(sample.z.mul(0.0085)).mul(1.8))
          .add(drift),
      ).mul(0.5).add(0.5)
      const breakup = sin(
        sample.z.mul(0.027)
          .sub(sample.x.mul(0.006))
          .sub(drift.mul(0.63)),
      ).mul(0.5).add(0.5)
      const ribbon = mix(float(0.035), float(1), pow(folded, float(2.35)))
        .mul(mix(float(0.3), float(1), pow(breakup, float(1.65))))
      const density = basin
        .mul(behindForebank)
        .mul(aboveFloor)
        .mul(belowCeiling)
        .mul(ribbon)
        .mul(mix(float(0.00012), float(0.0042), bankStrength))
        .toVar('valleyFogDensity')
      const opticalStep = density.mul(stepLength)
      opticalDepth.addAssign(opticalStep)

      // Water droplets forward-scatter the low sun. Looking across the sun
      // line warms the layer; the opposite valleys retain a cool slate tone.
      const forward = pow(
        clamp(dot(direction, SUN_DIRECTION), 0, 1),
        float(3.2),
      )
      const fogLight = mix(
        vec3(0.31, 0.39, 0.52),
        vec3(1.08, 0.75, 0.46),
        forward,
      )
      scattered.addAssign(fogLight.mul(opticalStep))
    })

    const transmittance = exp(opticalDepth.negate())
    const fogColour = scattered.div(opticalDepth.max(0.0001))
    const result = colour.rgb
      .mul(transmittance)
      .add(fogColour.mul(transmittance.oneMinus()))
    return vec4(result, colour.a)
  })()
}
