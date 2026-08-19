import { MeshStandardNodeMaterial, type Texture } from 'three/webgpu'
import {
  attribute,
  positionWorld,
  texture,
  vec3,
  varying,
  vertexColor,
} from 'three/tsl'
import type { TerrainRenderMode } from './renderModes'

/**
 * Creates the cheap far-field backdrop. It deliberately keeps normal
 * perspective depth so nearer proxy ridges occlude farther ones correctly.
 * HorizonProxy clears that depth after drawing while retaining the colour,
 * giving resident geometry a fresh authoritative depth buffer.
 */
export function createHorizonProxyMaterial(
  mode: TerrainRenderMode,
  residentMask?: Texture,
  worldSize = 1,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  })
  material.colorNode =
    mode === 'full'
      ? varying(
          vec3(attribute('farFieldFullColor', 'vec3') as any),
          'farFieldFullColour',
        )
      : vertexColor()
  if (residentMask) {
    // One nearest-filtered texel represents one streamed section. Discard the
    // proxy only beneath a section that is both visible and uploaded, so the
    // transition follows real cell edges rather than the camera radius.
    const maskUv = positionWorld.xz.add(worldSize * 0.5).div(worldSize)
    material.opacityNode = texture(residentMask, maskUv).r.oneMinus()
    material.alphaTest = 0.5
    material.alphaToCoverage = true
  }
  return material
}
