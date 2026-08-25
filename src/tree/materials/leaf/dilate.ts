/**
 * Alpha dilation for cutout atlases.
 *
 * Mip generation averages each channel against alpha independently, so a cutout
 * whose transparent texels hold nothing bleeds that nothing into every edge —
 * and it is not only the albedo that matters. Undilated height gives the rim
 * garbage normals and undilated roughness makes it mirror bright, which
 * together are the dark, glinting halo that gives away a game-foliage atlas
 * from across a field.
 */

const NEIGHBOUR_X = [-1, 1, 0, 0, -1, 1, -1, 1] as const
const NEIGHBOUR_Y = [0, 0, -1, 1, -1, -1, 1, 1] as const

/** Dilates a single-channel field into its transparent texels. */
export function dilateChannel(
  values: Float32Array,
  alpha: Float32Array,
  size: number,
  passes: number,
): void {
  dilateInterleaved(values, 1, alpha, size, passes)
}

/**
 * Flood-fills transparent texels of an interleaved field from their nearest
 * opaque neighbours, leaving alpha untouched. Standard alpha dilation.
 */
export function dilateInterleaved(
  values: Float32Array,
  stride: number,
  alpha: Float32Array,
  size: number,
  passes: number,
): void {
  const filled = new Uint8Array(size * size)
  for (let index = 0; index < filled.length; index += 1) {
    filled[index] = alpha[index]! > 0.02 ? 1 : 0
  }
  const totals = new Float32Array(stride)
  for (let pass = 0; pass < passes; pass += 1) {
    const next = Uint8Array.from(filled)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = y * size + x
        if (filled[index]) continue
        totals.fill(0)
        let found = 0
        for (let step = 0; step < 8; step += 1) {
          const neighbourX = x + NEIGHBOUR_X[step]!
          const neighbourY = y + NEIGHBOUR_Y[step]!
          if (neighbourX < 0 || neighbourX >= size) continue
          if (neighbourY < 0 || neighbourY >= size) continue
          const neighbour = neighbourY * size + neighbourX
          if (!filled[neighbour]) continue
          for (let slot = 0; slot < stride; slot += 1) {
            totals[slot] = totals[slot]! + values[neighbour * stride + slot]!
          }
          found += 1
        }
        if (found === 0) continue
        for (let slot = 0; slot < stride; slot += 1) {
          values[index * stride + slot] = totals[slot]! / found
        }
        next[index] = 1
      }
    }
    filled.set(next)
  }
}
