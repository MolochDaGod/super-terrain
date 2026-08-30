import {
  clamp,
  dot,
  exp,
  float,
  Fn,
  getViewPosition,
  mix,
  pow,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import type { Camera } from 'three/webgpu'
import { SUN_DIRECTION } from '../../terrain/rendering/full/atmosphere'

/**
 * Tree-scale height haze.
 *
 * The terrain fog is an authored cloud bank hundreds of metres from the world
 * origin, so it is intentionally absent from the standalone tree workspace.
 * This integrates a smooth height-dependent medium analytically along the
 * visible camera ray instead. It gives the crown a near/far depth read without
 * a ray-march: one depth reconstruction, one exponential and no shadow taps.
 *
 * It is not a replacement for shadowed volumetric shafts. Those require
 * several samples of the sun shadow map per pixel and belong in a cinematic
 * switch, not in an editor that has to remain responsive while authoring.
 */
/**
 * How far the medium is integrated, and how thick it is.
 *
 * A forest interior and a glacial valley are the same integral over wildly
 * different numbers: a stand is legible at twenty metres and the veil exists to
 * separate a near trunk from a far one, while a landscape's furthest ridge is
 * two kilometres off and the veil *is* the depth cue. Running the interior's
 * numbers over a landscape caps every distance past a hundred and fifty metres
 * at the same haze, so the ranges behind each other come back equally dark and
 * the frame reads as hard and flat — which is what a forest-scale constant
 * always does to a landscape.
 */
export interface TreeHazeProfile {
  /** Metres past which more distance adds no more haze. */
  maxDistance: number
  /** Metres of clear air in front of the camera. */
  clearNear: number
  /** Extinction per metre at ground level, and high above it. */
  densityLow: number
  densityHigh: number
  /** Metres over which the density falls from low to high. */
  altitude: number
  /** The most of the veil any pixel may take. */
  amountCap: number
  /** The veil away from the sun, and looking straight into it. */
  shade: readonly [number, number, number]
  forward: readonly [number, number, number]
  /**
   * How tightly the forward-scatter lobe hugs the sun.
   *
   * A stand's sun is high and mostly hidden, so a broad lobe reads as the air
   * between the trunks catching the light. A landscape's is on the horizon and
   * a broad lobe therefore covers half the frame: at power 4 a backlit hero
   * shot lost the entire sunward face of the massif under a cream wash.
   */
  forwardPower: number
}

/** The stand this was written for. */
export const FOREST_HAZE: TreeHazeProfile = {
  maxDistance: 150,
  clearNear: 9,
  densityLow: 0.0042,
  densityHigh: 0.0011,
  altitude: 32,
  amountCap: 0.2,
  // Green-grey: what fills the gaps between trunks has already come through
  // the canopy. A blue veil at twenty metres is the one thing a real forest
  // interior never has.
  shade: [0.2, 0.25, 0.19],
  forward: [0.98, 0.86, 0.6],
  forwardPower: 4,
}

/**
 * An open landscape under the same sky.
 *
 * Two kilometres of reach, a tenth of the density and a much higher cap: the
 * far ranges are meant to dissolve, and the near ground is meant to stay clear
 * for a good deal longer than a tree trunk does.
 */
export const LANDSCAPE_HAZE: TreeHazeProfile = {
  maxDistance: 2_600,
  clearNear: 45,
  densityLow: 0.00042,
  densityHigh: 0.00016,
  altitude: 420,
  amountCap: 0.62,
  // Blue slate, which is exactly what a forest must not have and exactly what
  // an open valley does: the air between here and that ridge is lit by the
  // whole sky.
  //
  // Its *brightness* has to sit near the sky's own near the horizon, and that
  // is not a matter of taste. The veil is applied to every pixel including the
  // sky itself — the sky reconstructs at the far plane, so it takes the full
  // cap — and a veil brighter than the sky therefore repaints the sky brighter
  // than the sky. At 0.44/0.53/0.63 that put the sky band sixty levels up and
  // clipped a sixth of it. Matched to the horizon it is very nearly a no-op
  // there, and still carries the distant ranges where it is meant to.
  shade: [0.22, 0.28, 0.35],
  forward: [0.72, 0.66, 0.55],
  forwardPower: 12,
}

export function treeAtmosphericHaze(
  colour: any,
  depthTexture: any,
  camera: Camera,
  profile: TreeHazeProfile = FOREST_HAZE,
): any {
  const projectionMatrixInverse = uniform(camera.projectionMatrixInverse)
  const cameraWorldMatrix = uniform(camera.matrixWorld)

  return Fn(() => {
    const screenUv = uv().toVar('treeHazeUv')
    const depth = depthTexture.sample(screenUv).r.toVar('treeHazeDepth')
    const viewPosition = getViewPosition(
      screenUv,
      depth,
      projectionMatrixInverse,
    ).toVar('treeHazeViewPosition')
    const worldPosition = cameraWorldMatrix
      .mul(vec4(viewPosition, 1))
      .xyz
      .toVar('treeHazeWorldPosition')
    const cameraPosition = cameraWorldMatrix
      .mul(vec4(0, 0, 0, 1))
      .xyz
      .toVar('treeHazeCameraPosition')
    const ray = worldPosition.sub(cameraPosition).toVar('treeHazeRay')
    // Sky reconstructs at the camera far plane. Capping the segment keeps the
    // sky veil deliberate and prevents far-plane precision from driving it.
    const distance = ray.length().min(profile.maxDistance).toVar('treeHazeDistance')
    const direction = ray.normalize().toVar('treeHazeDirection')
    const meanHeight = worldPosition.y.add(cameraPosition.y).mul(0.5)
      .toVar('treeHazeMeanHeight')

    // Clear the first few metres so bark close-ups stay crisp. Humid air is
    // denser near the ground, while the crown receives only a thin aerial veil.
    const travelled = distance.sub(profile.clearNear).max(0)
    const altitude = smoothstep(1, profile.altitude, meanHeight)
    const density = mix(float(profile.densityLow), float(profile.densityHigh), altitude)
    const amount = exp(travelled.mul(density).negate())
      .oneMinus()
      .min(profile.amountCap)
      .toVar('treeHazeAmount')

    // Inside a stand the air is not lit by open sky: what fills the gaps
    // between trunks is light that has already come through the canopy, so the
    // veil is a dim green-grey rather than the blue slate of an open valley,
    // and it only goes warm where a shaft is aimed at the camera. Getting this
    // backwards is most of what makes a rendered forest read as foggy — a blue
    // veil at twenty metres is the one thing a real forest interior never has.
    const forward = pow(
      clamp(dot(direction, SUN_DIRECTION), 0, 1),
      float(profile.forwardPower),
    )
    const hazeColour = mix(
      vec3(profile.shade[0], profile.shade[1], profile.shade[2]),
      vec3(profile.forward[0], profile.forward[1], profile.forward[2]),
      forward,
    )
    return vec4(mix(colour.rgb, hazeColour, amount), colour.a)
  })()
}
