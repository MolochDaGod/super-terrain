import { MeshBasicNodeMaterial } from 'three/webgpu'
import { Fn, cameraPosition, float, normalWorld, positionWorld, vec3 } from './nodes.ts'
import { sunIrradiance } from './lighting.ts'
import { sampleAlbedo, sampleDistance } from './sdfTrace.ts'
import type { SousaGI } from './SousaGI.ts'

export type DebugView = 'beauty' | 'gi' | 'direct' | 'albedo' | 'sdf'

export const DEBUG_VIEWS: DebugView[] = ['beauty', 'gi', 'direct', 'albedo', 'sdf']

/**
 * Flat overrides that isolate one stage of the rig. Reading a dark beauty frame
 * tells you nothing about *which* term is missing; these do.
 */
export function createDebugMaterial(gi: SousaGI, view: DebugView): MeshBasicNodeMaterial | null {
  if (view === 'beauty') return null
  const material = new MeshBasicNodeMaterial()
  const n = normalWorld.normalize()
  if (view === 'gi') {
    material.colorNode = gi.irradianceNode
  } else if (view === 'direct') {
    // Sun visibility through the distance field, without the shadow map.
    material.colorNode = Fn(() => sunIrradiance(gi.sky, gi.sdf, positionWorld, n, 32))()
  } else if (view === 'albedo') {
    material.colorNode = Fn(() => sampleAlbedo(gi.sdf, positionWorld, n))()
  } else {
    // Distance field around the surface, one stripe per voxel.
    material.colorNode = Fn(() => {
      const d = sampleDistance(gi.sdf, positionWorld.add(n.mul(gi.sdf.cell.mul(1.5))))
      return vec3(d.div(gi.sdf.cell.mul(8)).clamp(0, 1)).mul(
        float(0.5).add(cameraPosition.sub(positionWorld).length().mul(0)),
      )
    })()
  }
  return material
}
