import { BufferAttribute, BufferGeometry } from 'three/webgpu'
import type { CompiledLOD } from '../core/types'
import { addSectionSkirts } from './addSectionSkirts'

/** Builds the GPU geometry for one compiled LOD, including its watertight skirt. */
export function createSectionGeometry(
  lod: CompiledLOD,
  sectionSize: number,
): BufferGeometry {
  const skirted = addSectionSkirts(lod, sectionSize)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(skirted.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(skirted.normals, 3))
  geometry.setAttribute('color', new BufferAttribute(skirted.colors, 3))
  for (let field = 0; field < skirted.surfaceFields.length; field += 1) {
    geometry.setAttribute(
      `terrainSurface${field}`,
      new BufferAttribute(skirted.surfaceFields[field], 4, true),
    )
  }
  geometry.setAttribute(
    'terrainPaintWeights',
    new BufferAttribute(skirted.paintWeights, 4, true),
  )
  geometry.setIndex(new BufferAttribute(skirted.indices, 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
