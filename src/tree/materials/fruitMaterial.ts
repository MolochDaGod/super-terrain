import { MeshStandardNodeMaterial } from 'three/webgpu'
import { attribute, vec4 } from 'three/tsl'
import { applyAttributeInstanceTransform } from './leafMaterial'

/** Waxy fleshy fruit, kept separate from both bark and foliage materials. */
export function createFruitMaterial(
  attributeInstancing = false,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    name: 'instanced date fruit',
    color: 0xffffff,
    vertexColors: !attributeInstancing,
    roughness: 0.58,
    metalness: 0,
  })
  if (attributeInstancing) {
    applyAttributeInstanceTransform(material)
    material.colorNode = vec4(attribute<'vec3'>('treeInstanceColor', 'vec3'), 1)
  }
  return material
}
