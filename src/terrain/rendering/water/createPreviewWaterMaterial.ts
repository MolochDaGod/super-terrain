import { MeshBasicNodeMaterial } from 'three/webgpu'
import { attribute, clamp, color, mix, smoothstep } from 'three/tsl'

/**
 * Flat-shaded water for preview quality.
 *
 * Preview has no sky model, so the reflective material has nothing to mirror
 * and renders as a grey sheet. That matters now that water is something the
 * user paints: a brush whose result is invisible until the render mode changes
 * is a brush nobody can aim. This is deliberately not a cheap imitation of the
 * full material — it is a legible depth ramp, the same thing the section
 * overlays are.
 */
export function createPreviewWaterMaterial(turbidity: number): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  const depth: any = attribute('waterDepth', 'float')
  const shallow = color(0x63b8c8)
  const deep = color(0x123c52)
  const silt = color(0x8fb6ab)
  const body = mix(shallow, deep, smoothstep(0.2, 9, depth))
  material.colorNode = mix(body, silt, clamp(turbidity * 0.6, 0, 1))
  material.opacity = 0.74
  material.transparent = true
  material.depthWrite = false
  return material
}
