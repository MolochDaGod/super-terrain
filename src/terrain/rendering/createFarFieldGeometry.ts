import {
  BufferAttribute,
  BufferGeometry,
} from 'three/webgpu'
import type { FarFieldMeshData } from './FarFieldMesh'

/**
 * Builds one deliberately coarse world mesh used only beyond/below streamed
 * editable sections. At ~9k vertices it is cheap enough to create once while
 * retaining the procedural world's distant silhouette.
 */
export function createFarFieldGeometry(
  data: FarFieldMeshData,
): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3))
  geometry.setAttribute('color', new BufferAttribute(data.colors, 3))
  geometry.setAttribute(
    'farFieldFullColor',
    new BufferAttribute(data.fullColors, 3),
  )
  geometry.setIndex(new BufferAttribute(data.indices, 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
