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
export function treeAtmosphericHaze(
  colour: any,
  depthTexture: any,
  camera: Camera,
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
    const distance = ray.length().min(150).toVar('treeHazeDistance')
    const direction = ray.normalize().toVar('treeHazeDirection')
    const meanHeight = worldPosition.y.add(cameraPosition.y).mul(0.5)
      .toVar('treeHazeMeanHeight')

    // Clear the first few metres so bark close-ups stay crisp. Humid air is
    // denser near the ground, while the crown receives only a thin aerial veil.
    const travelled = distance.sub(9).max(0)
    const altitude = smoothstep(1, 32, meanHeight)
    const density = mix(float(0.0042), float(0.0011), altitude)
    const amount = exp(travelled.mul(density).negate())
      .oneMinus()
      .min(0.2)
      .toVar('treeHazeAmount')

    // Inside a stand the air is not lit by open sky: what fills the gaps
    // between trunks is light that has already come through the canopy, so the
    // veil is a dim green-grey rather than the blue slate of an open valley,
    // and it only goes warm where a shaft is aimed at the camera. Getting this
    // backwards is most of what makes a rendered forest read as foggy — a blue
    // veil at twenty metres is the one thing a real forest interior never has.
    const forward = pow(clamp(dot(direction, SUN_DIRECTION), 0, 1), float(4))
    const hazeColour = mix(
      vec3(0.2, 0.25, 0.19),
      vec3(0.98, 0.86, 0.6),
      forward,
    )
    return vec4(mix(colour.rgb, hazeColour, amount), colour.a)
  })()
}
