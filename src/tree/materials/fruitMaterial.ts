import { MeshStandardNodeMaterial } from 'three/webgpu'

/** Waxy fleshy fruit, kept separate from both bark and foliage materials. */
export function createFruitMaterial(): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({
    name: 'instanced date fruit',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.58,
    metalness: 0,
  })
}
