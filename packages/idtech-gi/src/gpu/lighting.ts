import { Color, Vector3 } from 'three/webgpu'
import type { Node } from './nodes.ts'
import {
  float,
  max,
  mix,
  pow,
  saturate,
  smoothstep,
  uniform,
  vec3,
} from './nodes.ts'
import { traceSoftShadow, type SdfBinding } from './sdfTrace.ts'


export interface SunSky {
  /** vec3 uniform: direction *toward* the sun. */
  direction: Node
  /** vec3 uniform: irradiance arriving on a surface facing the sun. */
  irradiance: Node
  zenith: Node
  horizon: Node
  ground: Node
  /** float uniform: scales sky and sun together. */
  exposure: Node
}

export function createSunSky(): SunSky {
  return {
    direction: uniform(new Vector3(0.42, 0.78, 0.46).normalize()) as Node,
    irradiance: uniform(new Vector3(5.2, 4.5, 3.4)) as Node,
    zenith: uniform(new Vector3(0.55, 0.85, 1.45)) as Node,
    horizon: uniform(new Vector3(1.15, 1.2, 1.3)) as Node,
    ground: uniform(new Vector3(0.22, 0.2, 0.17)) as Node,
    exposure: uniform(1) as Node,
  }
}

export function setSun(
  sky: SunSky,
  direction: Vector3,
  colour: Color,
  intensity: number,
): void {
  sky.direction.value.copy(direction).normalize()
  sky.irradiance.value.set(colour.r * intensity, colour.g * intensity, colour.b * intensity)
}

/** Radiance seen by a ray that leaves the scene. */
export function skyRadiance(sky: SunSky, dir: Node): Node {
  const up = dir.y
  const dome = mix(sky.horizon, sky.zenith, pow(saturate(up), float(0.55)))
  return mix(sky.ground, dome, smoothstep(float(-0.12), float(0.12), up)).mul(sky.exposure)
}

/**
 * Direct sun irradiance on a surface, with an SDF soft shadow. Matches the
 * rasterised directional light so bounce light and key light agree.
 */
export function sunIrradiance(
  sky: SunSky,
  sdf: SdfBinding,
  position: Node,
  normal: Node,
  shadowSteps = 32,
): Node {
  const ndl = max(normal.dot(sky.direction), float(0))
  const shadow = traceSoftShadow(
    sdf,
    position.add(normal.mul(sdf.cell.mul(1.5))),
    sky.direction,
    float(1e4),
    16,
    shadowSteps,
  )
  return sky.irradiance.mul(ndl).mul(shadow).mul(sky.exposure)
}

/** Sky irradiance reaching a surface, approximated by its cosine-weighted average. */
export function skyIrradiance(sky: SunSky, normal: Node): Node {
  const up = normal.y.mul(0.5).add(0.5)
  return mix(sky.ground, sky.zenith, up).mul(float(Math.PI)).mul(sky.exposure)
}

export function lambert(albedo: Node, irradiance: Node): Node {
  return albedo.mul(irradiance).mul(float(1 / Math.PI))
}

export const ZERO = vec3(0, 0, 0)
