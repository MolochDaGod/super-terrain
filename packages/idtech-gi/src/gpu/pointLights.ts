import { Color, Vector3 } from 'three/webgpu'
import type { Node } from './nodes.ts'
import {
  If,
  Loop,
  float,
  instancedArray,
  max,
  saturate,
  select,
  storage,
  uint,
  uniform,
  vec3,
} from './nodes.ts'
import { traceSoftShadow, type SdfBinding } from './sdfTrace.ts'

export interface GiPointLight {
  position: Vector3
  colour: Color
  /** Candela, matching three's physically-correct point lights. */
  intensity: number
  /** Cutoff distance; the falloff is windowed to reach zero here. */
  range: number
  /**
   * Emitter radius. Not decoration: a punctual `1/d²` term is unbounded, and a
   * probe ray that lands a few centimetres from the light returns a value large
   * enough to dominate its whole 32-ray estimate on its own. Giving the lamp a
   * physical size bounds the term and the flicker with it.
   */
  radius: number
  castShadow: boolean
}

export interface PointLightField {
  readonly capacity: number
  /** Replaces the light list. Anything past `capacity` is dropped. */
  set(lights: readonly GiPointLight[]): void
  /** Irradiance from every light at a surface point, with distance-field shadows. */
  irradiance(sdf: SdfBinding, position: Node, normal: Node, shadowSteps?: number): Node
  count: number
}

/**
 * Dynamic punctual lights that the GI rays can see.
 *
 * The whole point of a bounce solution is that moving a light moves the light
 * it throws onto nearby surfaces. That only happens if the probe rays shade
 * their hits with the same lights the raster pass uses, so the list lives in a
 * storage buffer both sides read.
 */
export function createPointLightField(capacity = 8): PointLightField {
  // xyz position, w range.
  // Radius rides in the emission buffer's unused lanes below.
  const geometry = instancedArray(capacity, 'vec4')
  // rgb colour * intensity, w emitter radius (negative disables shadowing).
  const emission = instancedArray(capacity, 'vec4')
  const geometryRead = (storage as Node)(geometry.value, 'vec4', capacity).toReadOnly()
  const emissionRead = (storage as Node)(emission.value, 'vec4', capacity).toReadOnly()
  const countU = uniform(0) as Node

  const geometryData = geometry.value.array as Float32Array
  const emissionData = emission.value.array as Float32Array

  const field: PointLightField = {
    capacity,
    count: 0,
    set(lights) {
      const n = Math.min(lights.length, capacity)
      for (let i = 0; i < n; i += 1) {
        const light = lights[i]!
        geometryData[i * 4] = light.position.x
        geometryData[i * 4 + 1] = light.position.y
        geometryData[i * 4 + 2] = light.position.z
        geometryData[i * 4 + 3] = light.range
        emissionData[i * 4] = light.colour.r * light.intensity
        emissionData[i * 4 + 1] = light.colour.g * light.intensity
        emissionData[i * 4 + 2] = light.colour.b * light.intensity
        emissionData[i * 4 + 3] = (light.castShadow ? 1 : -1) * Math.max(0.05, light.radius)
      }
      geometry.value.needsUpdate = true
      emission.value.needsUpdate = true
      countU.value = n
      field.count = n
    },
    irradiance(sdf, position, normal, shadowSteps = 24) {
      const total = vec3(0).toVar()
      Loop({ start: 0, end: capacity, type: 'uint' }, ({ i }: { i: Node }) => {
        If(float(i).lessThan(countU), () => {
          const geo = geometryRead.element(uint(i))
          const emit = emissionRead.element(uint(i))
          const delta = geo.xyz.sub(position)
          const distance = max(delta.length(), float(1e-3))
          const direction = delta.div(distance)
          const ndl = max(normal.dot(direction), float(0))
          If(ndl.greaterThan(float(0)).and(distance.lessThan(geo.w)), () => {
            // Inverse square, windowed to zero at the range so a light entering
            // or leaving a probe's reach does not step the probe's value.
            const radius = emit.w.abs()
            const window = saturate(float(1).sub(distance.div(geo.w).pow(4)))
            const falloff = window
              .mul(window)
              .div(max(distance.mul(distance), radius.mul(radius)))
            // A soft shadow rather than a binary one. A hard test flips between
            // 0 and 1 for rays that graze an edge, and with 32 rays per probe
            // one such flip is a visible step in the probe's value.
            const visible = traceSoftShadow(
              sdf,
              position.add(normal.mul(sdf.cell.mul(1.5))),
              direction,
              distance.sub(sdf.cell.mul(2)),
              float(8),
              shadowSteps,
            )
            const shadow = select(emit.w.greaterThan(float(0)), visible, float(1))
            total.addAssign(emit.rgb.mul(ndl).mul(falloff).mul(shadow))
          })
        })
      })
      return total
    },
  }
  field.set([])
  return field
}

export function emptyLight(): GiPointLight {
  return {
    position: new Vector3(),
    colour: new Color(1, 1, 1),
    intensity: 0,
    range: 1,
    radius: 0.25,
    castShadow: true,
  }
}
