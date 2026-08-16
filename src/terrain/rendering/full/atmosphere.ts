import { clamp, dot, exp, float, mix, pow, smoothstep, uniform, vec3 } from 'three/tsl'
import { falloff } from './fields'
import { DEFAULT_SUN } from '../environment/sunPosition'

/**
 * Aerial perspective.
 *
 * Distance haze is the strongest depth cue in the reference frames: every
 * receding ridge is lighter, bluer and lower-contrast than the one in front of
 * it. Two things make this read correctly and both are easy to get wrong:
 *
 *   1. The haze colour must be the colour of the *sky in that direction*, not a
 *      constant. A constant white fog reads as milk poured over the frame.
 *   2. Density must fall off with altitude and integrate along the ray, so a
 *      valley floor at 2 km is deeply veiled while a peak at the same distance
 *      stays crisp. That altitude difference is what separates ridge planes.
 */

export const HAZE_DENSITY = uniform(0.00026)
/** Extra low-lying mist, and the altitude it fills to. */
export const MIST_DENSITY = uniform(0.0011)
export const MIST_CEILING = uniform(70)
/** Metres of clear air before haze begins to accumulate. */
export const HAZE_START = uniform(180)
/** Inverse scale height, per metre. Larger means haze hugs the ground more. */
export const HAZE_HEIGHT_FALLOFF = uniform(0.0042)
export const SUN_DIRECTION = uniform(DEFAULT_SUN.direction.clone())

/** Keeps the shader's idea of the sun in step with the scene's. */
export function syncSunDirection(): void {
  SUN_DIRECTION.value.copy(DEFAULT_SUN.direction)
}

const HORIZON_COLOUR = vec3(0.44, 0.54, 0.72)
const ZENITH_COLOUR = vec3(0.14, 0.3, 0.62)
const SUN_HALO = vec3(1.1, 0.92, 0.7)

/**
 * Sky radiance in a direction, matched by eye to the Preetham dome so terrain
 * fades into exactly the colour that is drawn behind it.
 */
export function skyColour(direction: any): any {
  const up = clamp(direction.y, -1, 1)
  const gradient = mix(
    HORIZON_COLOUR,
    ZENITH_COLOUR,
    pow(smoothstep(-0.02, 0.62, up), float(0.8)),
  )
  const cosTheta = clamp(dot(direction, SUN_DIRECTION), -1, 1)
  // Two lobes: a tight halo next to the disc and a broad forward-scatter wash.
  const halo = pow(cosTheta.mul(0.5).add(0.5), float(28)).mul(0.85)
  const wash = pow(cosTheta.mul(0.5).add(0.5), float(5)).mul(0.16)
  return gradient.add(SUN_HALO.mul(halo.add(wash)))
}

/**
 * Returns `{ colour, amount }` for the haze between the camera and a surface.
 * `amount` is applied as a lerp on the shaded colour after lighting.
 */
export function aerialPerspective(
  viewDistance: any,
  viewDirection: any,
  surfaceHeight: any,
  cameraHeight: any,
): { colour: any; amount: any } {
  // Analytic integral of an exponentially decaying density along the segment
  // between the two endpoints, which keeps the falloff correct whether the ray
  // climbs a peak or runs along a valley floor.
  const meanHeight = surfaceHeight.add(cameraHeight).mul(0.5).toVar('meanHeight')
  const lowest = surfaceHeight.min(cameraHeight).max(-200)
  const highest = surfaceHeight.max(cameraHeight).max(-200)
  const rise = highest.sub(lowest).max(0.001)
  const meanDensity = exp(lowest.mul(HAZE_HEIGHT_FALLOFF).negate())
    .sub(exp(highest.mul(HAZE_HEIGHT_FALLOFF).negate()))
    .div(rise.mul(HAZE_HEIGHT_FALLOFF))
    .toVar('meanDensity')

  // Start offset: the first couple of hundred metres of air are effectively
  // clear, and veiling them is what makes near rock read as milk.
  const hazed = viewDistance.sub(HAZE_START).max(0)
  // A second, much denser and much shallower layer pooling on the valley
  // floors. This is what actually separates one ridge plane from the next:
  // uniform haze veils near and far equally, while mist only fills the low
  // ground between them.
  const mistDepth = falloff(MIST_CEILING, float(-40), meanHeight)
    .mul(viewDistance)
    .mul(MIST_DENSITY)
  const optical = hazed
    .mul(HAZE_DENSITY)
    .mul(meanDensity)
    .add(mistDepth)
    .toVar('opticalDepth')
  const amount = optical.negate().exp().oneMinus().clamp(0, 1).toVar('hazeAmount')

  // `viewDirection` points from the surface back to the camera, so the ray
  // travelling away from the eye is its negation.
  const colour = skyColour(viewDirection.negate())

  return { colour, amount }
}
