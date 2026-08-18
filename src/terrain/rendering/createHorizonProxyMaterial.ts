import { MeshStandardNodeMaterial } from 'three/webgpu'
import { attribute, float, vec3, varying, vertexColor } from 'three/tsl'
import type { TerrainRenderMode } from './renderModes'

/**
 * Creates the cheap far-field backdrop. Its fragment depth is pinned behind
 * authored geometry so streamed terrain and rocks always remain authoritative.
 */
export function createHorizonProxyMaterial(
  mode: TerrainRenderMode,
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
  material.depthNode = float(1)
  return material
}
