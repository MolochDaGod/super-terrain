import type { Vec3Like } from '../core/types'

interface AdaptiveCell {
  x: number
  z: number
  size: number
  sampledError: number
}

export interface AdaptiveHeightMeshOptions {
  originX: number
  originZ: number
  size: number
  resolution: number
  errorTolerance: number
  evaluate: (worldX: number, worldZ: number) => Vec3Like
}

export interface AdaptiveHeightMesh {
  positions: Float32Array
  /** World-space X/Z pair for each vertex, in position order. */
  parameters: number[]
  indices: Uint32Array
  /** Maximum measured deviation at the authoritative grid samples. */
  sampledError: number
  baselineVertexCount: number
}

const MAX_ROOT_SIZE = 8
const MIN_CELL_SIZE = 2

/**
 * Builds a crack-free restricted quadtree over the same samples as the regular
 * authoritative grid. A leaf is accepted only when its center-fan surface is
 * within `errorTolerance` of every regular-grid vertex it replaces.
 *
 * The section boundary always resolves to the original one-sample spacing, so
 * independently compiled neighbours retain identical weld coordinates. Leaves
 * are 2:1 balanced and coarse edges add the quarter points required by finer
 * neighbours; no T-junction is left in the emitted topology.
 */
export function createErrorBoundedHeightMesh(
  options: AdaptiveHeightMeshOptions,
): AdaptiveHeightMesh | undefined {
  const resolution = Math.floor(options.resolution)
  const rootSize = Math.min(
    MAX_ROOT_SIZE,
    largestPowerOfTwoFactor(resolution),
  )
  if (
    !Number.isFinite(options.size) ||
    options.size <= 0 ||
    !Number.isFinite(options.errorTolerance) ||
    options.errorTolerance < 0 ||
    resolution < 4 ||
    rootSize < MIN_CELL_SIZE * 2
  ) {
    return undefined
  }

  const stride = resolution + 1
  const samples = new Float64Array(stride * stride * 3)
  for (let z = 0; z <= resolution; z += 1) {
    const worldZ = options.originZ + (z / resolution) * options.size
    for (let x = 0; x <= resolution; x += 1) {
      const worldX = options.originX + (x / resolution) * options.size
      const point = options.evaluate(worldX, worldZ)
      const offset = (z * stride + x) * 3
      samples[offset] = point.x - options.originX
      samples[offset + 1] = point.y
      samples[offset + 2] = point.z - options.originZ
    }
  }

  let leaves: AdaptiveCell[] = []
  for (let z = 0; z < resolution; z += rootSize) {
    for (let x = 0; x < resolution; x += rootSize) {
      refineCell(
        { x, z, size: rootSize, sampledError: 0 },
        resolution,
        stride,
        samples,
        options.errorTolerance,
        leaves,
      )
    }
  }
  leaves = balanceCells(leaves, resolution, stride, samples)
  const ownership = cellOwnership(leaves, resolution)
  const positions: number[] = []
  const parameters: number[] = []
  const indices: number[] = []
  const vertices = new Map<number, number>()

  const vertexAt = (x: number, z: number): number => {
    const key = z * stride + x
    const existing = vertices.get(key)
    if (existing !== undefined) return existing
    const vertex = positions.length / 3
    const offset = key * 3
    positions.push(samples[offset], samples[offset + 1], samples[offset + 2])
    parameters.push(
      options.originX + (x / resolution) * options.size,
      options.originZ + (z / resolution) * options.size,
    )
    vertices.set(key, vertex)
    return vertex
  }

  for (const cell of leaves) {
    if (cell.size === MIN_CELL_SIZE) {
      // At the refinement floor, retain the authoritative grid's exact
      // checkerboard diagonals. A center fan has the same vertices and triangle
      // count but is a different piecewise-linear surface between them.
      for (let z = cell.z; z < cell.z + cell.size; z += 1) {
        for (let x = cell.x; x < cell.x + cell.size; x += 1) {
          const a = vertexAt(x, z)
          const b = vertexAt(x + 1, z)
          const c = vertexAt(x, z + 1)
          const d = vertexAt(x + 1, z + 1)
          if ((x + z) % 2 === 0) {
            indices.push(a, c, b, b, c, d)
          } else {
            indices.push(a, c, d, a, d, b)
          }
        }
      }
      continue
    }
    const half = cell.size / 2
    const quarter = cell.size / 4
    const polygon: number[] = []
    const add = (x: number, z: number) => polygon.push(vertexAt(x, z))
    const leftSplit = hasSmallerNeighbor(cell, 'left', ownership, resolution)
    const bottomSplit = hasSmallerNeighbor(cell, 'bottom', ownership, resolution)
    const rightSplit = hasSmallerNeighbor(cell, 'right', ownership, resolution)
    const topSplit = hasSmallerNeighbor(cell, 'top', ownership, resolution)

    add(cell.x, cell.z)
    if (leftSplit) add(cell.x, cell.z + quarter)
    add(cell.x, cell.z + half)
    if (leftSplit) add(cell.x, cell.z + cell.size - quarter)
    add(cell.x, cell.z + cell.size)
    if (bottomSplit) add(cell.x + quarter, cell.z + cell.size)
    add(cell.x + half, cell.z + cell.size)
    if (bottomSplit) add(cell.x + cell.size - quarter, cell.z + cell.size)
    add(cell.x + cell.size, cell.z + cell.size)
    if (rightSplit) add(cell.x + cell.size, cell.z + cell.size - quarter)
    add(cell.x + cell.size, cell.z + half)
    if (rightSplit) add(cell.x + cell.size, cell.z + quarter)
    add(cell.x + cell.size, cell.z)
    if (topSplit) add(cell.x + cell.size - quarter, cell.z)
    add(cell.x + half, cell.z)
    if (topSplit) add(cell.x + quarter, cell.z)

    const center = vertexAt(cell.x + half, cell.z + half)
    for (let edge = 0; edge < polygon.length; edge += 1) {
      indices.push(center, polygon[edge], polygon[(edge + 1) % polygon.length])
    }
  }

  return {
    positions: Float32Array.from(positions),
    parameters,
    indices: Uint32Array.from(indices),
    sampledError: leaves.reduce(
      (maximum, cell) => Math.max(maximum, cell.sampledError),
      0,
    ),
    baselineVertexCount: stride * stride,
  }
}

function refineCell(
  cell: AdaptiveCell,
  resolution: number,
  stride: number,
  samples: Float64Array,
  tolerance: number,
  output: AdaptiveCell[],
): void {
  if (cell.size <= MIN_CELL_SIZE) {
    output.push(cell)
    return
  }
  const error = cellPatchError(cell, stride, samples)
  const touchesBoundary =
    cell.x === 0 ||
    cell.z === 0 ||
    cell.x + cell.size === resolution ||
    cell.z + cell.size === resolution
  if (!touchesBoundary && error <= tolerance) {
    output.push({ ...cell, sampledError: error })
    return
  }

  const half = cell.size / 2
  refineCell(
    { x: cell.x, z: cell.z, size: half, sampledError: 0 },
    resolution,
    stride,
    samples,
    tolerance,
    output,
  )
  refineCell(
    { x: cell.x + half, z: cell.z, size: half, sampledError: 0 },
    resolution,
    stride,
    samples,
    tolerance,
    output,
  )
  refineCell(
    { x: cell.x, z: cell.z + half, size: half, sampledError: 0 },
    resolution,
    stride,
    samples,
    tolerance,
    output,
  )
  refineCell(
    {
      x: cell.x + half,
      z: cell.z + half,
      size: half,
      sampledError: 0,
    },
    resolution,
    stride,
    samples,
    tolerance,
    output,
  )
}

function cellPatchError(
  cell: AdaptiveCell,
  stride: number,
  samples: Float64Array,
): number {
  const half = cell.size / 2
  const anchors: readonly [number, number][] = [
    [cell.x, cell.z],
    [cell.x, cell.z + half],
    [cell.x, cell.z + cell.size],
    [cell.x + half, cell.z + cell.size],
    [cell.x + cell.size, cell.z + cell.size],
    [cell.x + cell.size, cell.z + half],
    [cell.x + cell.size, cell.z],
    [cell.x + half, cell.z],
  ]
  const center: readonly [number, number] = [
    cell.x + half,
    cell.z + half,
  ]
  let maximum = 0
  for (let z = cell.z; z <= cell.z + cell.size; z += 1) {
    for (let x = cell.x; x <= cell.x + cell.size; x += 1) {
      const prediction = interpolateFan(x, z, center, anchors, stride, samples)
      const offset = (z * stride + x) * 3
      const error = Math.hypot(
        samples[offset] - prediction[0],
        samples[offset + 1] - prediction[1],
        samples[offset + 2] - prediction[2],
      )
      maximum = Math.max(maximum, error)
    }
  }
  return maximum
}

function interpolateFan(
  x: number,
  z: number,
  center: readonly [number, number],
  anchors: readonly (readonly [number, number])[],
  stride: number,
  samples: Float64Array,
): readonly [number, number, number] {
  for (let index = 0; index < anchors.length; index += 1) {
    const first = anchors[index]
    const second = anchors[(index + 1) % anchors.length]
    const barycentric = barycentric2d(x, z, center, first, second)
    if (
      barycentric[0] < -1e-9 ||
      barycentric[1] < -1e-9 ||
      barycentric[2] < -1e-9
    ) {
      continue
    }
    const centerOffset = (center[1] * stride + center[0]) * 3
    const firstOffset = (first[1] * stride + first[0]) * 3
    const secondOffset = (second[1] * stride + second[0]) * 3
    return [
      samples[centerOffset] * barycentric[0] +
        samples[firstOffset] * barycentric[1] +
        samples[secondOffset] * barycentric[2],
      samples[centerOffset + 1] * barycentric[0] +
        samples[firstOffset + 1] * barycentric[1] +
        samples[secondOffset + 1] * barycentric[2],
      samples[centerOffset + 2] * barycentric[0] +
        samples[firstOffset + 2] * barycentric[1] +
        samples[secondOffset + 2] * barycentric[2],
    ]
  }
  throw new Error('Adaptive terrain sample lies outside its source cell')
}

function barycentric2d(
  x: number,
  z: number,
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): readonly [number, number, number] {
  const denominator =
    (b[1] - c[1]) * (a[0] - c[0]) +
    (c[0] - b[0]) * (a[1] - c[1])
  const first =
    ((b[1] - c[1]) * (x - c[0]) +
      (c[0] - b[0]) * (z - c[1])) /
    denominator
  const second =
    ((c[1] - a[1]) * (x - c[0]) +
      (a[0] - c[0]) * (z - c[1])) /
    denominator
  return [first, second, 1 - first - second]
}

function balanceCells(
  initial: AdaptiveCell[],
  resolution: number,
  stride: number,
  samples: Float64Array,
): AdaptiveCell[] {
  let leaves = initial
  while (true) {
    const ownership = cellOwnership(leaves, resolution)
    const split = new Set<AdaptiveCell>()
    for (const cell of leaves) {
      if (cell.size <= MIN_CELL_SIZE) continue
      for (const edge of ['left', 'bottom', 'right', 'top'] as const) {
        if (smallestNeighborSize(cell, edge, ownership, resolution) < cell.size / 2) {
          split.add(cell)
          break
        }
      }
    }
    if (split.size === 0) return leaves
    const next: AdaptiveCell[] = []
    for (const cell of leaves) {
      if (!split.has(cell)) {
        next.push(cell)
        continue
      }
      const half = cell.size / 2
      const children: AdaptiveCell[] = [
        { x: cell.x, z: cell.z, size: half, sampledError: 0 },
        { x: cell.x + half, z: cell.z, size: half, sampledError: 0 },
        { x: cell.x, z: cell.z + half, size: half, sampledError: 0 },
        {
          x: cell.x + half,
          z: cell.z + half,
          size: half,
          sampledError: 0,
        },
      ]
      for (const child of children) {
        if (child.size > MIN_CELL_SIZE) {
          child.sampledError = cellPatchError(child, stride, samples)
        }
      }
      next.push(
        ...children,
      )
    }
    leaves = next
  }
}

function cellOwnership(
  cells: readonly AdaptiveCell[],
  resolution: number,
): readonly AdaptiveCell[] {
  const ownership = new Array<AdaptiveCell>(resolution * resolution)
  for (const cell of cells) {
    for (let z = cell.z; z < cell.z + cell.size; z += 1) {
      for (let x = cell.x; x < cell.x + cell.size; x += 1) {
        ownership[z * resolution + x] = cell
      }
    }
  }
  return ownership
}

function hasSmallerNeighbor(
  cell: AdaptiveCell,
  edge: 'left' | 'bottom' | 'right' | 'top',
  ownership: readonly AdaptiveCell[],
  resolution: number,
): boolean {
  return smallestNeighborSize(cell, edge, ownership, resolution) < cell.size
}

function smallestNeighborSize(
  cell: AdaptiveCell,
  edge: 'left' | 'bottom' | 'right' | 'top',
  ownership: readonly AdaptiveCell[],
  resolution: number,
): number {
  let smallest = Infinity
  if (edge === 'left' || edge === 'right') {
    const x = edge === 'left' ? cell.x - 1 : cell.x + cell.size
    if (x < 0 || x >= resolution) return Infinity
    for (let z = cell.z; z < cell.z + cell.size; z += 1) {
      smallest = Math.min(smallest, ownership[z * resolution + x].size)
    }
  } else {
    const z = edge === 'top' ? cell.z - 1 : cell.z + cell.size
    if (z < 0 || z >= resolution) return Infinity
    for (let x = cell.x; x < cell.x + cell.size; x += 1) {
      smallest = Math.min(smallest, ownership[z * resolution + x].size)
    }
  }
  return smallest
}

function largestPowerOfTwoFactor(value: number): number {
  if (!Number.isInteger(value) || value <= 0) return 0
  let factor = 1
  while (value % (factor * 2) === 0) factor *= 2
  return factor
}
