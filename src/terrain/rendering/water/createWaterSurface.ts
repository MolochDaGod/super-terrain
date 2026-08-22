import { BufferAttribute, BufferGeometry } from 'three/webgpu'
import {
  sampleHeight,
  sampleShowcaseRiver,
} from '../../compiler/heightField'
import type { AABB } from '../../core/types'

export interface WaterSurfaceOptions {
  region: AABB
  level: number
  seed: number
  /** Grid spacing in metres. Only affects the depth attribute, not the plane. */
  step?: number
  /**
   * 0..1 permission for water to exist at a point. Defaults to the demo's
   * authored outlet corridor, which is what the shipped scene floods; the
   * editor passes the painted water mask instead.
   */
  coverage?: (x: number, z: number) => number
}

/**
 * A flat water plane, tessellated only so every vertex can carry the depth of
 * water above the terrain beneath it.
 *
 * The shoreline is not in this mesh. Cells are emitted wherever the ground is
 * anywhere near the level, and the terrain itself occludes the parts that are
 * dry — which means the waterline is exact at pixel resolution and follows the
 * ground even where a CSG edit has since moved it. A mesh trimmed to a polyline
 * would be wrong the moment anything was sculpted.
 *
 * The depth attribute is what makes the result read as water rather than as a
 * mirror: shallows over a bar are bright and take the ground's colour, while
 * the channels between them go dark and take the sky's.
 */
export function createWaterSurface(options: WaterSurfaceOptions): BufferGeometry {
  const step = options.step ?? 4
  const { region, level, seed } = options
  const coverageAt = options.coverage ?? ((x: number, z: number) => sampleShowcaseRiver(x, z, seed))
  const columns = Math.max(2, Math.round((region.max.x - region.min.x) / step) + 1)
  const rows = Math.max(2, Math.round((region.max.z - region.min.z) / step) + 1)

  const depths = new Float32Array(columns * rows)
  const river = new Float32Array(columns * rows)
  const positions = new Float32Array(columns * rows * 3)
  for (let row = 0; row < rows; row += 1) {
    const z = region.min.z + row * step
    for (let column = 0; column < columns; column += 1) {
      const x = region.min.x + column * step
      const index = row * columns + column
      positions[index * 3] = x
      positions[index * 3 + 1] = level
      positions[index * 3 + 2] = z
      depths[index] = level - sampleHeight(x, z, seed)
      river[index] = coverageAt(x, z)
    }
  }

  // Drop cells that are entirely on dry land. They would be invisible anyway,
  // and at this extent that is most of the grid: the basin floor is a fraction
  // of the rectangle the region has to span to reach around it.
  const indices: number[] = []
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = row * columns + column
      const b = a + 1
      const c = a + columns
      const d = c + 1
      // A water level is not permission to flood every unrelated hollow in
      // the basin. Keep the exact terrain-cut shoreline, but only inside the
      // authored outlet corridor. The one-cell fringe lets the terrain itself
      // remain the final shoreline mask and avoids a visible geometric ribbon
      // edge when a sculpt crosses the bank.
      const corridor = Math.max(river[a], river[b], river[c], river[d])
      if (corridor <= 0.001) continue
      const deepest = Math.max(depths[a], depths[b], depths[c], depths[d])
      // One cell of slack, so the ring of quads straddling the shore is kept
      // and the terrain has something to cut the waterline out of.
      if (deepest < -step) continue
      indices.push(a, c, b, b, c, d)
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('waterDepth', new BufferAttribute(depths, 1))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}
