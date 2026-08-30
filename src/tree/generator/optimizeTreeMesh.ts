import { MeshoptEncoder } from 'meshoptimizer'
import type { ProceduralTreeAsset, TreeMeshData } from './types'

/**
 * Losslessly reorders triangle and vertex streams for the post-transform cache.
 * No topology or attribute value changes; only their storage/submission order
 * does. `optsize=false` selects GPU rendering performance over compressed size.
 */
export async function optimizeTreeMeshSubmission(
  asset: ProceduralTreeAsset,
): Promise<void> {
  await MeshoptEncoder.ready
  for (const lod of asset.lods) optimizeMesh(lod.wood)
}

function optimizeMesh(mesh: TreeMeshData): void {
  const [remap, uniqueVertices] = MeshoptEncoder.reorderMesh(
    mesh.indices,
    true,
    false,
  )
  mesh.positions = remapAttribute(mesh.positions, 3, remap, uniqueVertices)
  mesh.normals = remapAttribute(mesh.normals, 3, remap, uniqueVertices)
  mesh.colors = remapAttribute(mesh.colors, 3, remap, uniqueVertices)
  mesh.uvs = remapAttribute(mesh.uvs, 2, remap, uniqueVertices)
}

function remapAttribute(
  source: Float32Array,
  itemSize: number,
  remap: Uint32Array,
  uniqueVertices: number,
): Float32Array {
  const target = new Float32Array(uniqueVertices * itemSize)
  for (let sourceIndex = 0; sourceIndex < remap.length; sourceIndex += 1) {
    const targetIndex = remap[sourceIndex]!
    if (targetIndex === 0xffffffff) continue
    const sourceOffset = sourceIndex * itemSize
    target.set(
      source.subarray(sourceOffset, sourceOffset + itemSize),
      targetIndex * itemSize,
    )
  }
  return target
}
