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
  dilateFields([{ values, stride }], alpha, size, passes)
}

export interface DilationField {
  values: Float32Array
  stride: number
}

/**
 * Dilates several channels through the same cutout in one traversal.
 *
 * Every leaf field uses the same alpha silhouette and therefore discovers the
 * same neighbours on every pass. Walking that silhouette once for all fields
 * preserves the per-channel result while avoiding six duplicate flood fills.
 */
export function dilateFields(
  fields: readonly DilationField[],
  alpha: Float32Array,
  size: number,
  passes: number,
): void {
  const filled = new Uint8Array(size * size)
  for (let index = 0; index < filled.length; index += 1) {
    filled[index] = alpha[index]! > 0.02 ? 1 : 0
  }
  const offsets: number[] = []
  let totalStride = 0
  for (const field of fields) {
    offsets.push(totalStride)
    totalStride += field.stride
  }
  const totals = new Float32Array(totalStride)
  let frontier = new Int32Array(filled.length)
  let nextFrontier = new Int32Array(filled.length)
  const queued = new Uint8Array(filled.length)
  let frontierLength = 0
  // Seed only transparent texels touching the authored silhouette. Subsequent
  // passes visit the next one-texel ring instead of rescanning the whole card.
  for (let index = 0; index < filled.length; index += 1) {
    if (!filled[index]) continue
    const x = index % size
    const y = Math.floor(index / size)
    for (let step = 0; step < 8; step += 1) {
      const neighbourX = x + NEIGHBOUR_X[step]!
      const neighbourY = y + NEIGHBOUR_Y[step]!
      if (neighbourX < 0 || neighbourX >= size) continue
      if (neighbourY < 0 || neighbourY >= size) continue
      const neighbour = neighbourY * size + neighbourX
      if (filled[neighbour] || queued[neighbour]) continue
      queued[neighbour] = 1
      frontier[frontierLength++] = neighbour
    }
  }
  for (let pass = 0; pass < passes; pass += 1) {
    if (frontierLength === 0) break
    for (let frontierIndex = 0; frontierIndex < frontierLength; frontierIndex += 1) {
        const index = frontier[frontierIndex]!
        const x = index % size
        const y = Math.floor(index / size)
        totals.fill(0)
        let found = 0
        for (let step = 0; step < 8; step += 1) {
          const neighbourX = x + NEIGHBOUR_X[step]!
          const neighbourY = y + NEIGHBOUR_Y[step]!
          if (neighbourX < 0 || neighbourX >= size) continue
          if (neighbourY < 0 || neighbourY >= size) continue
          const neighbour = neighbourY * size + neighbourX
          if (!filled[neighbour]) continue
          for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
            const field = fields[fieldIndex]!
            const totalOffset = offsets[fieldIndex]!
            const valueOffset = neighbour * field.stride
            for (let slot = 0; slot < field.stride; slot += 1) {
              totals[totalOffset + slot] = totals[totalOffset + slot]! +
                field.values[valueOffset + slot]!
            }
          }
          found += 1
        }
        if (found === 0) continue
        for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
          const field = fields[fieldIndex]!
          const totalOffset = offsets[fieldIndex]!
          const valueOffset = index * field.stride
          for (let slot = 0; slot < field.stride; slot += 1) {
            field.values[valueOffset + slot] = totals[totalOffset + slot]! / found
          }
        }
    }
    // Publish the entire ring together: values within one dilation pass must
    // not feed one another merely because they happened to be visited first.
    for (let index = 0; index < frontierLength; index += 1) {
      filled[frontier[index]!] = 1
    }
    let nextLength = 0
    for (let frontierIndex = 0; frontierIndex < frontierLength; frontierIndex += 1) {
      const index = frontier[frontierIndex]!
      queued[index] = 0
      const x = index % size
      const y = Math.floor(index / size)
      for (let step = 0; step < 8; step += 1) {
        const neighbourX = x + NEIGHBOUR_X[step]!
        const neighbourY = y + NEIGHBOUR_Y[step]!
        if (neighbourX < 0 || neighbourX >= size) continue
        if (neighbourY < 0 || neighbourY >= size) continue
        const neighbour = neighbourY * size + neighbourX
        if (filled[neighbour] || queued[neighbour]) continue
        queued[neighbour] = 1
        nextFrontier[nextLength++] = neighbour
      }
    }
    const previous = frontier
    frontier = nextFrontier
    nextFrontier = previous
    frontierLength = nextLength
  }
}
