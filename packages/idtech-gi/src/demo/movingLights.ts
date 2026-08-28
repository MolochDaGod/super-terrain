import {
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  PointLight,
  SphereGeometry,
  Vector3,
  type Box3,
} from 'three/webgpu'
import type { GiPointLight } from '../gpu/pointLights.ts'

export interface MovingLightRig {
  /** Feed to `SousaGI.setPointLights` each frame. */
  lights: GiPointLight[]
  group: Group
  visible: boolean
  setVisible(value: boolean): void
  update(time: number): void
}

interface Path {
  colour: Color
  intensity: number
  range: number
  radius: number
  /** Position as a function of time, in the model's own bounds. */
  at(time: number, bounds: Box3, size: Vector3, centre: Vector3, out: Vector3): void
}

const PATHS: Path[] = [
  {
    colour: new Color(1, 0.42, 0.12),
    intensity: 26,
    range: 14,
    radius: 0.35,
    at(t, bounds, size, centre, out) {
      // Sweeps the long axis at waist height: the clearest read on bounce, the
      // floor and the near column go warm as it passes and recover after.
      out.set(
        centre.x + Math.sin(t * 0.42) * size.x * 0.36,
        bounds.min.y + size.y * 0.1,
        centre.z + Math.sin(t * 0.21) * size.z * 0.1,
      )
    },
  },
  {
    colour: new Color(0.16, 0.62, 1),
    intensity: 22,
    range: 13,
    radius: 0.3,
    at(t, bounds, size, centre, out) {
      // Circles one end of the arcade, dipping behind the columns so the
      // occlusion term has something to do.
      out.set(
        centre.x - size.x * 0.28 + Math.cos(t * 0.55) * size.x * 0.1,
        bounds.min.y + size.y * 0.16 + Math.sin(t * 0.9) * size.y * 0.05,
        centre.z + Math.sin(t * 0.55) * size.z * 0.3,
      )
    },
  },
  {
    colour: new Color(0.5, 1, 0.35),
    intensity: 18,
    range: 12,
    radius: 0.3,
    at(t, bounds, size, centre, out) {
      out.set(
        centre.x + size.x * 0.3 + Math.sin(t * 0.33) * size.x * 0.08,
        bounds.min.y + size.y * 0.34,
        centre.z + Math.cos(t * 0.7) * size.z * 0.26,
      )
    },
  },
]

/**
 * Coloured lamps that fly through the scene.
 *
 * Static bounce is easy to mistake for a baked ambient term. A light that moves
 * makes the claim testable by eye: the colour it throws onto nearby surfaces
 * has to travel with it, arrive before it does at a corner, and leave when it
 * leaves.
 */
export function createMovingLights(
  bounds: Box3,
  count = PATHS.length,
): MovingLightRig {
  const size = bounds.getSize(new Vector3())
  const centre = bounds.getCenter(new Vector3())
  const group = new Group()
  const paths = PATHS.slice(0, Math.max(0, Math.min(count, PATHS.length)))
  const lights: GiPointLight[] = []
  const rasterLights: PointLight[] = []
  const bulbs: Mesh[] = []
  const bulbGeometry = new SphereGeometry(Math.max(0.04, size.length() * 0.004), 12, 8)

  for (const path of paths) {
    const light = new PointLight(path.colour, path.intensity, path.range, 2)
    light.castShadow = false
    group.add(light)
    rasterLights.push(light)

    const material = new MeshBasicNodeMaterial()
    material.color = path.colour.clone()
    material.toneMapped = false
    const bulb = new Mesh(bulbGeometry, material)
    group.add(bulb)
    bulbs.push(bulb)

    lights.push({
      position: new Vector3(),
      colour: path.colour.clone(),
      intensity: path.intensity,
      range: path.range,
      radius: path.radius,
      castShadow: true,
    })
  }

  const scratch = new Vector3()
  const rig: MovingLightRig = {
    lights,
    group,
    visible: true,
    setVisible(value) {
      rig.visible = value
      group.visible = value
      // The GI list is separate from the scene graph, so hiding the group is
      // not enough — the rays would still see them.
      for (let i = 0; i < lights.length; i += 1) {
        lights[i]!.intensity = value ? paths[i]!.intensity : 0
      }
    },
    update(time) {
      for (let i = 0; i < paths.length; i += 1) {
        paths[i]!.at(time, bounds, size, centre, scratch)
        rasterLights[i]!.position.copy(scratch)
        bulbs[i]!.position.copy(scratch)
        lights[i]!.position.copy(scratch)
      }
    },
  }
  rig.update(0)
  return rig
}
