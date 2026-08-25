import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three/webgpu'

export interface FoliageClumpGeometryOptions {
  /** Blades in one clump. Every instance draws all of them. */
  blades: number
  /** Quads up the length of a blade. One is a flat card, four is a curve. */
  segments: number
  /**
   * Where this ring's slice of the shared instance buffer begins.
   *
   * Carrying it on the geometry rather than in the indirect draw's
   * `firstInstance` field is deliberate: a non-zero `firstInstance` in an
   * indirect draw needs the optional `indirect-first-instance` WebGPU feature,
   * which is not universally available. A constant vertex attribute reaches the
   * same place with no feature requirement, and it costs eight bytes on a
   * geometry that has at most a couple of hundred vertices.
   */
  ringOffset: number
  /**
   * Metres the blades of one clump scatter over, floor.
   *
   * A coarse ring places one clump every metre and a half and packs twenty
   * blades into it. Left at the species' natural tuft radius those twenty
   * blades would stand in a single spike with bare ground all around it — the
   * exact "sparse at range" artefact the ring was widened to avoid. The clump
   * has to grow to fill the cell it was given.
   */
  spread: number
}

/**
 * The template a single clump instance draws.
 *
 * The blade index, the parameter along the blade and the side across it are
 * packed into `position`. Nothing reads that attribute as a position — the
 * material replaces `positionLocal` outright — but keeping the data there
 * rather than in three extra float attributes halves the vertex fetch, and it
 * means the geometry is a perfectly ordinary indexed `BufferGeometry` that
 * three, the inspector and `compileAsync` all understand without special cases.
 *
 * A clump rather than a blade is the instancing unit on purpose. A blade is
 * only ten triangles; at that size the per-instance overhead dominates the
 * work, and the grouping is also what lets neighbouring blades share a
 * bending phase and a hue, which is what real tufts do.
 */
export function createFoliageClumpGeometry({
  blades,
  segments,
  ringOffset,
  spread,
}: FoliageClumpGeometryOptions): BufferGeometry {
  const rows = segments + 1
  const vertexCount = blades * rows * 2
  const triangleCount = blades * segments * 2

  const packed = new Float32Array(vertexCount * 3)
  const ringData = new Float32Array(vertexCount * 2)
  const indices = new Uint16Array(triangleCount * 3)

  let vertex = 0
  let index = 0
  for (let blade = 0; blade < blades; blade += 1) {
    const first = vertex
    for (let row = 0; row < rows; row += 1) {
      const t = row / segments
      for (const side of [-1, 1]) {
        packed[vertex * 3] = t
        packed[vertex * 3 + 1] = side
        packed[vertex * 3 + 2] = (blade + 0.5) / blades
        ringData[vertex * 2] = ringOffset
        ringData[vertex * 2 + 1] = spread
        vertex += 1
      }
    }
    for (let row = 0; row < segments; row += 1) {
      const a = first + row * 2
      const b = a + 1
      const c = a + 2
      const d = a + 3
      indices[index] = a
      indices[index + 1] = c
      indices[index + 2] = b
      indices[index + 3] = b
      indices[index + 4] = c
      indices[index + 5] = d
      index += 6
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(packed, 3))
  geometry.setAttribute('ringData', new BufferAttribute(ringData, 2))
  geometry.setIndex(new BufferAttribute(indices, 1))
  // The real extent is decided by the population kernel, so the attribute
  // bounds are meaningless. Publish a sphere big enough that nothing in three
  // — shadow frusta, the inspector, a stray `computeBoundingSphere` — decides
  // this mesh is a point at the origin.
  geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 1e6)
  geometry.name = `foliage-clump-${blades}x${segments}`
  return geometry
}
