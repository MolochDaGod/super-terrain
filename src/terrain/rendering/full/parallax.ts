import {
  Break,
  If,
  Loop,
  clamp,
  dot,
  float,
  int,
  max,
  mix,
  normalize,
  smoothstep,
  vec3,
} from 'three/tsl'
import { falloff, fbmLod, ridgedLod } from './fields'
import type { LayerWeights } from './surface'

/**
 * Parallax occlusion mapping against a world-space micro-relief field.
 *
 * The terrain has no UV parametrisation — it is arbitrary-topology mesh — so
 * this marches in world space along the tangent projection of the view ray
 * instead of in texture space. The result is real self-occlusion for cracks and
 * stones: they slide correctly against each other as the camera moves, and
 * silhouette-adjacent pixels see the far wall of a crack rather than a flat
 * texture. It is deliberately gated to close range, where it is visible, and
 * dissolved before the step count would start costing more than it returns.
 */

/** Maximum virtual displacement, metres. Matches the tallest layer relief. */
export const PARALLAX_DEPTH = 0.4

/**
 * A deliberately cheap stand-in for the full layer stack, used only inside the
 * march. It must be monotonically related to the real relief, not identical to
 * it: eight steps of the full stack would cost more than the whole rest of the
 * material.
 */
export function proxyHeight(position: any, weights: LayerWeights): any {
  const crack = ridgedLod(position, float(0.9), 2, float(0))
  const stones = fbmLod(position, float(0.18), 1, float(0))
  const rocky = weights.rock.add(weights.scree.mul(0.8)).clamp(0, 1)
  return mix(stones.mul(0.35), crack.mul(0.55).add(stones.mul(0.45)), rocky)
}

/**
 * Returns the world position where the view ray meets the virtual surface.
 * `strength` in [0, 1] fades the whole effect out with distance.
 */
export function parallaxPosition(
  position: any,
  normal: any,
  view: any,
  weights: LayerWeights,
  strength: any,
): any {
  const facing = clamp(dot(normal, view), 0.12, 1).toVar('parallaxFacing')
  // Grazing angles need more steps: the ray travels further per unit depth.
  const steps = mix(float(10), float(4), facing).toVar('parallaxSteps')
  const depth = float(PARALLAX_DEPTH).mul(strength).toVar('parallaxDepth')

  // Tangential component of the view ray, scaled so one unit of depth moves the
  // sample by the correct lateral distance.
  const tangential = view.sub(normal.mul(dot(view, normal))).toVar('parallaxTangent')
  const stepVector = tangential.div(facing).mul(depth).div(steps).negate().toVar('parallaxStep')
  const stepDepth = depth.div(steps).toVar('parallaxStepDepth')

  const marched = vec3(position).toVar('parallaxSample')
  const currentDepth = float(0).toVar('parallaxCurrentDepth')
  const previous = vec3(position).toVar('parallaxPrevious')
  const previousDelta: any = float(0).toVar('parallaxPreviousDelta')

  // Start from the top of the virtual slab and walk down into the surface.
  const surfaceDepth = depth.mul(proxyHeight(position, weights).oneMinus()).toVar('parallaxSurface')
  const delta: any = surfaceDepth.sub(currentDepth).toVar('parallaxDelta')

  Loop({ start: int(0), end: int(10), type: 'int', condition: '<' }, ({ i }: any) => {
    If(float(i).greaterThanEqual(steps), () => {
      Break()
    })
    If(delta.lessThanEqual(0), () => {
      Break()
    })
    previous.assign(marched)
    previousDelta.assign(delta)
    marched.addAssign(stepVector)
    currentDepth.addAssign(stepDepth)
    const sampled = depth.mul(proxyHeight(marched, weights).oneMinus())
    delta.assign(sampled.sub(currentDepth))
  })

  // Linear intersection between the last two samples removes the stair-stepping
  // that plain steep parallax leaves on grazing surfaces.
  const blend = clamp(previousDelta.div(max(previousDelta.sub(delta), 0.0001)), 0, 1)
  return mix(previous, marched, blend)
}

/** Fades parallax out by distance and by how edge-on the surface is. */
export function parallaxStrength(viewDistance: any, facing: any): any {
  return falloff(46, 14, viewDistance).mul(smoothstep(0.06, 0.3, facing)).clamp(0, 1)
}

/**
 * Cheap self-shadowing of the micro-relief against the sun. Without it, a
 * parallaxed surface reads as a flat print at low sun angles.
 */
export function parallaxShadow(
  position: any,
  normal: any,
  sunDirection: any,
  weights: LayerWeights,
  strength: any,
): any {
  const facing = clamp(dot(normal, sunDirection), 0.05, 1)
  const tangential = sunDirection.sub(normal.mul(dot(sunDirection, normal)))
  const steps = 3
  const depth = float(PARALLAX_DEPTH).mul(strength)
  const startHeight = proxyHeight(position, weights).toVar('shadowStart')
  const occlusion = float(0).toVar('shadowOcclusion')
  for (let step = 1; step <= steps; step += 1) {
    const t = float(step / steps)
    const sample = position.add(tangential.div(facing).mul(depth).mul(t))
    const expected = startHeight.add(t.mul(facing).mul(1.4))
    occlusion.addAssign(max(proxyHeight(sample, weights).sub(expected), 0))
  }
  return clamp(occlusion.mul(2.4).oneMinus(), 0, 1)
}

/** Normalised view vector plus its length, computed once. */
export function viewVector(
  position: any,
  cameraPositionNode: any,
): { direction: any; distance: any } {
  const offset = cameraPositionNode.sub(position)
  const distance = offset.length().toVar('viewDistance')
  return { direction: normalize(offset).toVar('viewDirection'), distance }
}
