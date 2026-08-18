import { Mesh } from 'three'
import {
  GLTFLoader,
  type GLTF,
} from 'three/examples/jsm/loaders/GLTFLoader.js'

export interface ImportedCsgMesh {
  positions: number[]
  indices: number[]
}

/** Reads all triangle meshes from a binary glTF and bakes their node transforms. */
export async function importCsgGlb(file: File): Promise<ImportedCsgMesh> {
  const buffer = await file.arrayBuffer()
  const gltf = await new Promise<GLTF>(
    (resolve, reject) => {
      new GLTFLoader().parse(buffer, '', resolve, reject)
    },
  )
  gltf.scene.updateMatrixWorld(true)
  const positions: number[] = []
  const indices: number[] = []

  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh) || !object.geometry) return
    const geometry = object.geometry.clone()
    geometry.applyMatrix4(object.matrixWorld)
    const position = geometry.getAttribute('position')
    if (!position || position.count < 3) {
      geometry.dispose()
      return
    }
    const vertexOffset = positions.length / 3
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      positions.push(
        position.getX(vertex),
        position.getY(vertex),
        position.getZ(vertex),
      )
    }
    const index = geometry.getIndex()
    if (index) {
      for (let offset = 0; offset < index.count; offset += 1) {
        indices.push(vertexOffset + index.getX(offset))
      }
    } else {
      for (let vertex = 0; vertex < position.count; vertex += 1) {
        indices.push(vertexOffset + vertex)
      }
    }
    geometry.dispose()
  })

  if (positions.length < 9 || indices.length < 3) {
    throw new Error('The GLB does not contain a triangle mesh')
  }
  return { positions, indices }
}
