import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  attribute,
  cameraPosition,
  clamp,
  dot,
  float,
  mix,
  mx_noise_float,
  normalize,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  time,
  vec2,
  vec3,
} from 'three/tsl'
import { SUN_DIRECTION } from '../full/atmosphere'

/**
 * The braided river.
 *
 * Water is the only near-mirror in the frame, and that is the whole reason it
 * is worth having: it lays the valley the terrain is standing in flat on the
 * floor of the shot. Two things have to be true for it to read as water rather
 * than as a silky sheet:
 *
 *   1. It has to reflect **the scene**, not just the sky. A Fresnel-weighted
 *      sky gradient on a flat plane has no features in it at all, so it has
 *      nothing to ripple — no edges to break, no dark mountain against a bright
 *      sky for the chop to shred. It looks like poured metal because that is
 *      exactly the information content of it. So there is a real planar
 *      reflection pass here, and the ripple field distorts its lookup.
 *   2. It has to have an **edge**. Real water gets bright, broken and shallow
 *      before it stops, over a band a few metres wide, and the ground beside it
 *      is dark and wet. Without that the plane just intersects the ground along
 *      a hard mathematical line.
 */
export interface WaterMaterialOptions {
  /** Planar reflection of the scene, from `reflector()`. */
  reflection: any
}

export function createWaterMaterial(
  options: WaterMaterialOptions,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()

  const depth: any = attribute('waterDepth', 'float').toVar('waterDepth')
  const point = positionWorld
  const view: any = normalize(cameraPosition.sub(point)).toVar('waterView')

  // Three ripple fields. One alone reads as a repeating pattern the moment it
  // is seen at a grazing angle, which is the only angle a river in a wide shot
  // is ever seen at, and the coarse band is what actually breaks the reflected
  // skyline up rather than just roughening the surface.
  const drift = time.mul(0.06)
  const chopField = vec3(point.x.mul(0.9), drift.mul(5), point.z.mul(0.9))
  const near = vec3(point.x.mul(0.3), drift.mul(3), point.z.mul(0.3))
  const far = vec3(point.x.mul(0.055).add(drift), float(0), point.z.mul(0.055))
  const epsilon = 0.4
  const wave = (offset: any): any =>
    mx_noise_float(chopField.add(offset))
      .mul(0.25)
      .add(mx_noise_float(near.add(offset)).mul(0.6))
      .add(mx_noise_float(far.add(offset)))

  const height = wave(vec3(0, 0, 0))
  const slopeX = wave(vec3(epsilon, 0, 0)).sub(height)
  const slopeZ = wave(vec3(0, 0, epsilon)).sub(height)
  // Chop scales with depth: a bar under a hand's width of water barely moves,
  // while an open channel has the fetch to build a real ripple.
  const chop = smoothstep(0.1, 2.2, depth).mul(0.26)
  const normal: any = normalize(
    vec3(slopeX.mul(chop).negate(), float(1), slopeZ.mul(chop).negate()),
  ).toVar('waterNormal')

  const facing = clamp(dot(normal, view), 0, 1)
  // Schlick, with water's 0.02 normal-incidence reflectance. At the grazing
  // angles most of this surface is seen at, this is very close to 1 — which is
  // exactly why a wide river reads as its surroundings rather than as a colour.
  const fresnel = float(0.02).add(
    float(0.98).mul(pow(facing.oneMinus(), float(5))),
  )

  // The reflection is sampled in screen space, so the ripple has to displace
  // the *lookup*, not the ray. Scaling that displacement down with depth keeps
  // the shallows over a bar from smearing the mountain behind them.
  const reflection = options.reflection
  reflection.uvNode = reflection.uvNode.add(
    vec2(slopeX, slopeZ).mul(chop.mul(0.5)),
  )
  // The reflected pass draws the sky dome as well as the terrain, so it is the
  // whole reflection and not just the scene half of it. The sun track below is
  // still added separately: the sky mesh carries no sun disc, and the specular
  // highlight of the sun on water is the single most recognisable thing about
  // the surface.
  const reflected = reflect(view.negate(), normal)
  const mirrored = reflection.rgb

  // Body colour: glacial melt, so a green-grey rather than an ocean blue, and
  // it only shows where there is enough water under the surface to have a
  // colour at all. Over the bars it gives way to the wet gravel beneath.
  const deep = vec3(0.018, 0.045, 0.048)
  const shallow = vec3(0.075, 0.086, 0.062)
  const body = mix(shallow, deep, smoothstep(0.2, 3.2, depth))

  // The sun's own track, tightened well past what the sky model's halo gives,
  // so the glare has a hard broken edge instead of a soft blob.
  const glint = pow(clamp(dot(reflected, SUN_DIRECTION), 0, 1), float(220)).mul(3.4)

  // The edge. Two bands: the last half metre is broken white water over gravel,
  // and the two metres behind it are shallow enough to show the bed through
  // them. The noise is what stops the waterline reading as a contour drawn on
  // the ground — a real one is ragged at the scale of the stones making it.
  const edgeNoise = mx_noise_float(
    vec3(point.x.mul(0.55), drift, point.z.mul(0.55)),
  ).mul(0.35)
  const wash = smoothstep(2.4, 0.15, depth.sub(edgeNoise))
  const foam = smoothstep(0.9, 0.05, depth.sub(edgeNoise.mul(1.6)))

  const open = mix(body, mirrored, fresnel).add(vec3(1.0, 0.78, 0.52).mul(glint))
  material.colorNode = mix(
    mix(open, vec3(0.19, 0.2, 0.18), wash.mul(0.55)),
    vec3(0.5, 0.53, 0.55),
    foam.mul(0.8),
  )
  material.transparent = false
  return material
}
