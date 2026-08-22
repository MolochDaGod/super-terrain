import type { TerrainModifier } from '../../terrain/modifiers/types'
import { tunnelPortalDistance } from '../../terrain/modifiers/tunnel'

/** Row title and secondary line for one modifier, shared by the stack and the
    selection panel so a modifier is named identically wherever it appears. */
export function modifierLabel(modifier: TerrainModifier): string {
  switch (modifier.type) {
    case 'brush-stroke':
      return `${modifier.domain === 'mesh' ? 'Mesh' : 'Height'} · ${modifier.mode}`
    case 'weight-paint':
      return `Paint · ${modifier.channel} ${modifier.mode}`
    case 'sculpt-layer':
      return `Layer · ${modifier.name}`
    case 'material-settings':
      return 'Terrain materials'
    case 'boolean-subtract':
      return modifier.carves?.length
        ? 'Mesh · tunnel + cave carve'
        : 'Mesh · tunnel subtract'
    case 'boolean-volume':
      return modifier.backend === 'bvh-csg-cave-dig-v1'
        ? 'Mesh · cave carve'
        : `Mesh · volume ${modifier.operation}`
    case 'remesh':
      return 'Mesh · density'
    case 'tessellate':
      return 'Mesh · tessellate'
    case 'noise':
      return 'Height · noise'
    case 'field-displacement':
      return 'Field displacement'
  }
}

export function modifierMeta(modifier: TerrainModifier): string | undefined {
  switch (modifier.type) {
    case 'brush-stroke':
      return `${modifier.points.length} samples`
    case 'weight-paint':
      return `${modifier.points.length} samples · ${modifier.channel}`
    case 'boolean-subtract':
      return `${tunnelPortalDistance(modifier).toFixed(0)} m · r ${modifier.radius.toFixed(1)} m${modifier.carves?.length ? ` · ${modifier.carves.length} carves` : ''}`
    case 'boolean-volume':
      return `${modifier.volumes.length} ${modifier.volumes.length === 1 ? 'volume' : 'volumes'}`
    default:
      return undefined
  }
}
