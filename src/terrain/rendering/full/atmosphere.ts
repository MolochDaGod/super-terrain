import {
  Fn,
  If,
  clamp,
  dot,
  exp,
  float,
  mix,
  pow,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl'
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

export const HAZE_DENSITY = uniform(0.00038)
/**
 * The valley fog: cloud lying on the floor of the basin.
 *
 * It is meant to pool in the low ground and be *seen*, as a distinct thing with
 * a top to it, sitting under rock that stands clear above. That means shallow
 * and local, not dense: pushed up until it separates every ridge plane it
 * becomes an overlay on the whole frame, everything reads through a sheet of
 * grey, and the fog stops looking like weather and starts looking like a
 * post-process. The ceiling is the setting that matters most here — it is what
 * gives the layer a surface for the crags to rise out of.
 */
export const MIST_DENSITY = uniform(0.0018)
/** Altitude the fog fills to, and the level below which it is at full strength. */
export const MIST_CEILING = uniform(48)
export const MIST_FLOOR = uniform(-30)
/**
 * Metres of clear air before the fog starts to accumulate. Without this the
 * layer veils the rock at the viewer's feet as hard as the ridge a kilometre
 * away, and the frame turns to milk instead of gaining depth.
 */
export const MIST_START = uniform(170)
/** Metres of clear air before haze begins to accumulate. */
export const HAZE_START = uniform(320)
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
 * Fog is water droplets, not air: it scatters far more strongly forward than
 * Rayleigh does, and it scatters every wavelength alike. So the same layer that
 * reads as cold blue-grey looking away from the sun turns to bright warm white
 * looking into it, and that split across a single frame is most of what makes
 * a fogged valley look lit rather than washed out.
 */
const MIST_SHADE = vec3(0.24, 0.3, 0.39)
const MIST_LIT = vec3(1.18, 0.88, 0.61)

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
const evaluateAerialPerspective = /*@__PURE__*/ Fn(
  ([viewDistance, viewDirection, surfaceHeight, cameraHeight]: [
    any,
    any,
    any,
    any,
  ]) => {
  // Analytic integral of an exponentially decaying density along the segment
  // between the two endpoints, which keeps the falloff correct whether the ray
  // climbs a peak or runs along a valley floor.
  // Start offset: the first couple of hundred metres of air are effectively
  // clear, and veiling them is what makes near rock read as milk.
  const hazed = viewDistance.sub(HAZE_START).max(0)
  // A second, much denser and much shallower layer pooling on the valley
  // floors. This is what actually separates one ridge plane from the next:
  // uniform haze veils near and far equally, while mist only fills the low
  // ground between them.
  // How much of the ray actually runs through the layer. Testing the segment's
  // mean height instead — which is what this did — says that a camera on the
  // valley floor looking at a peak twice the height of the fog is looking
  // through solid fog, because the average of the two endpoints is still below
  // the ceiling. The result is a frame where the one subject that is meant to
  // stand clear of the murk is the most veiled thing in it. Taking the fraction
  // of the endpoints' altitude range that lies under the ceiling is still only
  // an approximation of the integral, but it is the right shape: it goes to
  // zero as the far end climbs out.
  const lowest = surfaceHeight.min(cameraHeight).toVar('mistLow')
  const highest = surfaceHeight.max(cameraHeight).toVar('mistHigh')
  const submerged = MIST_CEILING.sub(lowest)
    .div(highest.sub(lowest).max(1))
    .clamp(0, 1)
  const mistDepth = falloff(MIST_CEILING, MIST_FLOOR, lowest)
    .mul(submerged)
    .mul(viewDistance.sub(MIST_START).max(0))
    .mul(MIST_DENSITY)
    .toVar('mistDepth')
  const optical = float(mistDepth as any).toVar('opticalDepth')
  If(hazed.greaterThan(0), () => {
    const hazeLow = lowest.max(-200)
    const hazeHigh = highest.max(-200)
    const rise = hazeHigh.sub(hazeLow).max(0.001)
    const meanDensity = exp(hazeLow.mul(HAZE_HEIGHT_FALLOFF).negate())
      .sub(exp(hazeHigh.mul(HAZE_HEIGHT_FALLOFF).negate()))
      .div(rise.mul(HAZE_HEIGHT_FALLOFF))
    optical.addAssign(hazed.mul(HAZE_DENSITY).mul(meanDensity))
  })
  const amount = optical.negate().exp().oneMinus().clamp(0, 1).toVar('hazeAmount')

  // `viewDirection` points from the surface back to the camera, so the ray
  // travelling away from the eye is its negation.
  const colour = vec3(HORIZON_COLOUR).toVar('hazeColour')
  If(amount.greaterThan(0), () => {
    // How much of the veil is fog rather than clear-air haze. The two are lit
    // differently, so mixing by their share is the only way a frame can have
    // cold fog in the shadowed side valleys and a blazing one down the sun line.
    const mistShare = mistDepth.div(optical.max(0.0001)).clamp(0, 1)
    const forward = clamp(dot(viewDirection.negate(), SUN_DIRECTION), 0, 1)
    const mistColour: any = mix(MIST_SHADE, MIST_LIT, pow(forward, float(2.2)))
    colour.assign(
      mix(skyColour(viewDirection.negate()), mistColour, mistShare.mul(0.88) as any),
    )
  })

    return vec4(colour, amount)
  },
)

export function aerialPerspective(
  viewDistance: any,
  viewDirection: any,
  surfaceHeight: any,
  cameraHeight: any,
): { colour: any; amount: any } {
  const result = evaluateAerialPerspective(
    viewDistance,
    viewDirection,
    surfaceHeight,
    cameraHeight,
  ) as any
  return { colour: result.xyz, amount: result.w }
}
