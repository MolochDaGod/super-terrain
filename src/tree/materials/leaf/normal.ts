import { clamp01 } from '../proceduralNoise'

/**
 * Packs the tangent-space normal map.
 *
 * Two things decide which way a texel faces, and they work at different scales.
 * The blade's own plane says which way the whole leaf is turned, and the relief
 * field says what the cupping, the veins and the surface grain do to it. They
 * are combined by adding the relief's slope into the blade's plane rather than
 * by replacing one with the other, which keeps a steeply turned blade turned
 * however much detail is written on top of it.
 *
 * The relief gradient is taken over the dilated height, so the rim reads as a
 * continuation of the blade rather than as a cliff into empty texels.
 */
export function packNormals(
  height: Float32Array,
  basis: Float32Array,
  alpha: Float32Array,
  target: Uint8Array,
  size: number,
  strengthScale = 0.012,
): void {
  const strength = size * strengthScale
  for (let y = 0; y < size; y += 1) {
    const above = Math.max(0, y - 1)
    const below = Math.min(size - 1, y + 1)
    for (let x = 0; x < size; x += 1) {
      const left = Math.max(0, x - 1)
      const right = Math.min(size - 1, x + 1)
      const index = y * size + x
      const dx = (height[y * size + right]! - height[y * size + left]!) * strength
      const dy = (height[below * size + x]! - height[above * size + x]!) * strength
      // An untouched texel has no blade behind it; fall back to facing out.
      const baseZ = basis[index * 3 + 2]!
      const plane = baseZ === 0
        ? [0, 0, 1]
        : [basis[index * 3]!, basis[index * 3 + 1]!, baseZ]
      // Slope addition, in the plane's own terms: the relief tilts the blade
      // further rather than overwriting which way it was already turned.
      const nx = plane[0]! - dx * plane[2]!
      const ny = plane[1]! - dy * plane[2]!
      const nz = plane[2]!
      const inverse = 1 / Math.max(1e-5, Math.hypot(nx, ny, nz))
      const offset = index * 4
      target[offset] = toByte(nx * inverse * 0.5 + 0.5)
      target[offset + 1] = toByte(ny * inverse * 0.5 + 0.5)
      target[offset + 2] = toByte(nz * inverse * 0.5 + 0.5)
      target[offset + 3] = Math.round(clamp01(alpha[index]!) * 255)
    }
  }
}

function toByte(value: number): number {
  return Math.round(clamp01(value) * 255)
}
