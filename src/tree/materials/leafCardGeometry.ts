import { BufferAttribute, BufferGeometry } from 'three/webgpu'
import type { TreeFoliageData } from '../generator/types'

export interface FoliageBatch {
  matrices: Float32Array
  colors: Float32Array
  count: number
}

/**
 * A bowed card whose normals fan outward from its centre.
 *
 * A flat quad has exactly one normal, so a crown of flat quads flips between
 * fully lit and fully unlit as cards rotate — the hard-edged confetti look.
 * Bowing the card and fanning its normals makes each one shade like a piece of
 * a sphere, and because the compiler aims that fan out of the crown, the canopy
 * as a whole lights as a single soft volume rather than as thousands of
 * independently flickering planes.
 */
export function createLeafCardGeometry(): BufferGeometry {
  const divisions = 3
  // Keep just enough curvature for a spray to catch a range of light without
  // turning every leaf blade in the atlas into an inflated, moulded relief.
  // The texture normal map supplies blade-scale curvature; this mesh only
  // bends the whole twig spray by a few centimetres.
  const bow = 0.12
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (let row = 0; row <= divisions; row += 1) {
    for (let column = 0; column <= divisions; column += 1) {
      const u = column / divisions
      const v = row / divisions
      const x = u - 0.5
      const y = v - 0.5
      positions.push(x, v, -bow * (x * x + y * y))
      const nx = 2 * bow * x
      const ny = 2 * bow * y
      const inverse = 1 / Math.hypot(nx, ny, 1)
      normals.push(nx * inverse, ny * inverse, inverse)
      uvs.push(u, v)
    }
  }
  const stride = divisions + 1
  for (let row = 0; row < divisions; row += 1) {
    for (let column = 0; column < divisions; column += 1) {
      const corner = row * stride + column
      indices.push(
        corner,
        corner + 1,
        corner + stride + 1,
        corner,
        corner + stride + 1,
        corner + stride,
      )
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(normals), 3))
  geometry.setAttribute('uv', new BufferAttribute(Float32Array.from(uvs), 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

/** Regroups the compiled card list into one instance buffer per atlas spray. */
export function splitFoliageByVariant(data: TreeFoliageData): FoliageBatch[] {
  const variantCount = Math.max(1, data.variantCount)
  const counts = new Uint32Array(variantCount)
  for (let index = 0; index < data.count; index += 1) {
    counts[variantOf(data, index, variantCount)]! += 1
  }
  const batches = Array.from({ length: variantCount }, (_, variant) => ({
    matrices: new Float32Array(counts[variant]! * 16),
    colors: new Float32Array(counts[variant]! * 3),
    count: counts[variant]!,
  }))
  const cursors = new Uint32Array(variantCount)
  for (let index = 0; index < data.count; index += 1) {
    const variant = variantOf(data, index, variantCount)
    const batch = batches[variant]!
    const slot = cursors[variant]!
    batch.matrices.set(data.matrices.subarray(index * 16, index * 16 + 16), slot * 16)
    batch.colors.set(data.colors.subarray(index * 3, index * 3 + 3), slot * 3)
    cursors[variant] = slot + 1
  }
  return batches
}

function variantOf(data: TreeFoliageData, index: number, variantCount: number): number {
  return Math.min(variantCount - 1, data.variants[index] ?? 0)
}
