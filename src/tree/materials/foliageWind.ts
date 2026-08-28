import { cross, dot, float, normalize, sin, vec2, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { hash21 } from '../../foliage/foliageNoise'
import {
  foliageTime,
  foliageWind,
  foliageWindDirection,
} from '../../foliage/foliageRuntime'

/**
 * Radians the spray nods downwind under a full gust.
 *
 * Small on purpose. A leaf spray is anchored to a branchlet that does not move
 * in this scene — only the cards do — so anything large enough to read as a
 * branch bending instead reads as foliage sliding off the wood it grows on.
 */
const SWAY_RADIANS = 0.12

/** Radians of the faster, smaller cross-wind twitch. */
const FLUTTER_RADIANS = 0.032

/** Radians per second of a spray's own nod. About a seven-second cycle. */
const SWAY_RATE = 0.55

/** Radians per second of the flutter. Fast enough to be alive, slow enough to be air. */
const FLUTTER_RATE = 1.9

type Vec3Node = Node<'vec3'>

export interface SwayedVertex {
  position: Vec3Node
  normal: Vec3Node
}

/**
 * Wind for instanced leaf sprays.
 *
 * Every card carries its own world matrix, so its translation column is the
 * point where the spray meets the twig. Rotating the card about that point,
 * rather than translating it, is what makes the motion read as growth rather
 * than as drift: the petiole stays put and the tip travels, because the lever
 * arm is already in the geometry — the card spans y 0 to 1 from attachment to
 * tip, so a rotation about the origin gives the tip all the movement for free.
 *
 * Three scales, the same structure the grass uses and for the same reason. A
 * slow front crossing the stand is what makes a gust legible as weather; a
 * per-card phase is what stops a canopy moving as one rigid object; the flutter
 * keeps a close card alive between gusts. All of it reads the wind uniforms the
 * grass reads, so one gust crosses the meadow and the canopy together instead
 * of the two disagreeing about which way the air is going.
 */
export function foliageSway(
  anchor: Vec3Node,
  offset: Vec3Node,
  normal: Vec3Node,
): SwayedVertex {
  const heading = normalize(foliageWindDirection)

  // The gust front. Distance along the wind minus time is a wave traveling
  // downwind; two of them at unrelated wavelengths keep it from reading as the
  // single repeating sine it is.
  const along = dot(vec2(anchor.x, anchor.z), heading)
  const phase = along.div(foliageWind.y).sub(foliageTime.mul(foliageWind.z))
  const gust = sin(phase).mul(0.5).add(0.5)
  const swell = sin(phase.mul(0.31).add(1.7)).mul(0.5).add(0.5)
  const power = foliageWind.x.mul(float(0.2).add(gust.mul(swell).mul(1.15)))

  // One number per card, stable for the life of the stand and identical across
  // the card's own vertices — which is what keeps the card rigid instead of
  // shearing it.
  const seed = hash21(vec2(anchor.x.add(anchor.y.mul(7.31)), anchor.z))

  const nod = power
    .mul(float(0.6).add(sin(foliageTime.mul(SWAY_RATE).add(seed.mul(6.2831853))).mul(0.4)))
    .mul(float(SWAY_RADIANS))
  const flutter = foliageWind.w
    .mul(float(FLUTTER_RADIANS))
    .mul(sin(foliageTime.mul(FLUTTER_RATE).add(seed.mul(37.7))))
    .mul(power.mul(0.7).add(0.3))

  // Rotating about `tip` swings the card downwind; rotating about `downwind`
  // swings it across the wind. Giving each card a share of the second, scaled
  // by its own seed, is what stops a canopy tipping along one shared axis —
  // real sprays hang at every angle and none of them nods due south.
  const tip = vec3(heading.y, 0, heading.x.negate())
  const downwind = vec3(heading.x, 0, heading.y)
  const lateral = nod.mul(seed.sub(0.5).mul(0.7)).add(flutter)

  // Cross products are linear in the axis, so the two rotations combine into
  // one axis and one cross per vector rather than two of each.
  const axis = tip.mul(nod).add(downwind.mul(lateral))
  return {
    position: offset.add(cross(axis, offset)),
    // A spray that moves without turning stays a flat colour while it slides.
    // Carrying the same rotation onto the normal is what makes the canopy
    // glitter as the light catches blades at new angles.
    normal: normalize(normal.add(cross(axis, normal))),
  }
}
