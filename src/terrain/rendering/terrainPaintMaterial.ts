import { Color } from 'three/webgpu'
import {
  attribute,
  clamp,
  float,
  max,
  mix,
  vec3,
  vec4,
  varying,
} from 'three/tsl'
import type { TerrainMaterialSettings } from './materialSettings'

/** Blends the four authored paint channels over an existing auto-material. */
export function applyTerrainPaint(
  baseColor: any,
  baseRoughness: any,
  settings: TerrainMaterialSettings,
): { color: any; roughness: any; influence: any } {
  const weights = varying(
    vec4(attribute('terrainPaintWeights', 'vec4') as any),
    'terrainPaintWeightsVarying',
  )
  const total = weights.x
    .add(weights.y)
    .add(weights.z)
    .add(weights.w)
    .toVar('terrainPaintTotal')
  const divisor = max(total, float(0.0001))
  const channels = settings.channels.map((channel) => {
    const color = new Color(channel.color).convertSRGBToLinear()
    return {
      color: vec3(color.r, color.g, color.b),
      roughness: float(channel.roughness),
    }
  })
  const paintedColor = channels[0].color
    .mul(weights.x)
    .add(channels[1].color.mul(weights.y))
    .add(channels[2].color.mul(weights.z))
    .add(channels[3].color.mul(weights.w))
    .div(divisor)
  const paintedRoughness = channels[0].roughness
    .mul(weights.x)
    .add(channels[1].roughness.mul(weights.y))
    .add(channels[2].roughness.mul(weights.z))
    .add(channels[3].roughness.mul(weights.w))
    .div(divisor)
  const influence = clamp(total, 0, 1)

  return {
    color: mix(baseColor, paintedColor, influence),
    roughness: mix(baseRoughness, paintedRoughness, influence),
    influence,
  }
}
