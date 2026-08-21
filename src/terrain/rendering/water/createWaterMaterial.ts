import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  mix,
  normalize,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  texture,
  time,
  vec2,
  vec3,
} from 'three/tsl'
import { SUN_DIRECTION } from '../full/atmosphere'
import { createWaterDetailTexture } from '../textures/createSurfaceDetailTextures'

export interface WaterMaterialOptions {
  /** Planar reflection of the scene, from `reflector()`. */
  reflection: any
}

export interface WaterMaterialResources {
  material: MeshBasicNodeMaterial
  dispose(): void
}

/**
 * Reflective glacial water with texture-baked crossed wave trains.
 *
 * The reflection is still the real mirrored scene; only its normal field moved
 * from six per-fragment Perlin evaluations to two filtered texture samples.
 * That both sharpens the reflected ridge line and leaves enough GPU time for a
 * higher-resolution reflection target.
 */
export function createWaterMaterial(
  options: WaterMaterialOptions,
): WaterMaterialResources {
  const waveTexture = createWaterDetailTexture()
  const material = new MeshBasicNodeMaterial()

  const depth: any = attribute('waterDepth', 'float').toVar('waterDepth')
  const point = positionWorld
  const view: any = normalize(cameraPosition.sub(point)).toVar('waterView')
  const drift = time.mul(0.008)
  const firstUv = point.xz
    .mul(0.016)
    .add(vec2(drift, drift.mul(-0.72)))
  const rotated = vec2(
    point.x.mul(-0.72).add(point.z.mul(0.69)),
    point.x.mul(-0.69).add(point.z.mul(-0.72)),
  )
  const secondUv = rotated
    .mul(0.058)
    .add(vec2(drift.mul(-1.7), drift.mul(1.25)))
  const first = texture(waveTexture, firstUv).toVar('waterWaveFirst')
  const second = texture(waveTexture, secondUv).toVar('waterWaveSecond')
  const slope = first.rg
    .mul(2)
    .sub(1)
    .add(second.rg.mul(2).sub(1).mul(0.48))
    .toVar('waterSlope')
  const openWater = smoothstep(0.18, 2.6, depth)
  // A sheltered meltwater channel carries centimetre ripples, not open-sea
  // chop. Keeping the normal close to vertical preserves the reflected ridge
  // silhouettes and lets the two filtered wave trains supply just enough
  // movement to keep the plane from reading as glass.
  const chop = openWater.mul(0.085)
  const normal: any = normalize(
    vec3(slope.x.mul(chop).negate(), float(1), slope.y.mul(chop).negate()),
  ).toVar('waterNormal')

  const facing = clamp(dot(normal, view), 0, 1)
  const fresnel = float(0.025).add(
    // Schlick-like water Fresnel. The former 2.35 exponent made even moderately
    // facing pixels a bright cyan copy of the sky; a dielectric water surface
    // stays dark until the view is genuinely grazing.
    float(0.975).mul(pow(facing.oneMinus(), float(4.6))),
  )

  const reflection = options.reflection
  reflection.uvNode = reflection.uvNode.add(
    slope.mul(chop.mul(0.016)),
  )
  const mirrored = reflection.rgb
  const reflected = reflect(view.negate(), normal)

  // Clear, mineral-rich melt water. Shallows retain the gravel's green-brown
  // family; deep channels absorb toward a blue-black instead of a flat cyan.
  const deep = vec3(0.005, 0.016, 0.019)
  const shallow = vec3(0.058, 0.059, 0.052)
  const body = mix(shallow, deep, smoothstep(0.1, 3.8, depth))
  const sunFacing = clamp(dot(reflected, SUN_DIRECTION), 0, 1)
  const glint = pow(sunFacing, float(230)).mul(3.8)
  const sunSheen = pow(sunFacing, float(34)).mul(0.12)

  const edgeBreakup = first.b
    .mul(0.68)
    .add(second.b.mul(0.32))
    .sub(0.5)
  const wash = smoothstep(0.08, 1.35, depth.sub(edgeBreakup.mul(0.42))).oneMinus()
  const foam = smoothstep(0.025, 0.42, depth.sub(edgeBreakup.mul(0.28))).oneMinus()
  // A raw planar reflection is a second copy of the HDR sky. On a narrow dark
  // glacial channel that made every pixel a pale ribbon, independent of depth.
  // Water absorbs most reflected radiance before it reaches the eye; retain
  // the real mirrored ridges and cloud motion, but tint and attenuate them into
  // the blue-black body instead of replacing the body wholesale.
  const mirrorWeight = fresnel.mul(0.92).clamp(0, 0.94)
  // Preserve the actual mirrored mountains and clouds, but let the iron-rich
  // glacial water absorb blue slightly faster than the warm horizon. This is a
  // neutral reflection tint, not a painted bronze overlay: sunset colour still
  // comes only from what the reflector camera really sees.
  const mirroredWater = mirrored
    .sub(vec3(0.035))
    .mul(vec3(0.82, 0.77, 0.71))
    .clamp(0, 4)
  const open = mix(body, mirroredWater, mirrorWeight)
    .add(vec3(1.08, 0.62, 0.29).mul(glint))
    .add(vec3(0.31, 0.3, 0.28).mul(sunSheen))
  const shoreline = mix(open, vec3(0.09, 0.092, 0.083), wash.mul(0.22))
  material.colorNode = mix(shoreline, vec3(0.15, 0.15, 0.135), foam.mul(0.08))
  material.transparent = false

  return {
    material,
    dispose() {
      material.dispose()
      waveTexture.dispose()
    },
  }
}
