import type { AABB } from '../core/types'

export interface MeshQueryStats {
  visitedNodes: number
  testedTriangles: number
}

interface BuildNode {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
  left: number
  right: number
  start: number
  count: number
}

const DEFAULT_LEAF_TRIANGLES = 8

/**
 * Compact, immutable triangle AABB tree for editor-side spatial queries.
 *
 * The tree is built lazily by EditableMesh, keeps only typed arrays after
 * construction, and returns source triangle indices in deterministic order.
 */
export class MeshSpatialIndex {
  private readonly bounds: Float32Array
  private readonly children: Int32Array
  private readonly ranges: Uint32Array
  private readonly triangleOrder: Uint32Array
  private readonly positions: Float32Array
  private readonly triangles: Uint32Array

  constructor(
    positions: Float32Array,
    triangles: Uint32Array,
    leafTriangles = DEFAULT_LEAF_TRIANGLES,
  ) {
    this.positions = positions
    this.triangles = triangles
    const triangleCount = triangles.length / 3
    const order = Array.from({ length: triangleCount }, (_, triangle) => triangle)
    const nodes: BuildNode[] = []
    if (triangleCount > 0) {
      buildNode(
        nodes,
        order,
        0,
        triangleCount,
        Math.max(2, Math.floor(leafTriangles)),
        positions,
        triangles,
      )
    }

    this.bounds = new Float32Array(nodes.length * 6)
    this.children = new Int32Array(nodes.length * 2)
    this.ranges = new Uint32Array(nodes.length * 2)
    this.triangleOrder = Uint32Array.from(order)
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const node = nodes[nodeIndex]
      this.bounds.set(
        [node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ],
        nodeIndex * 6,
      )
      this.children[nodeIndex * 2] = node.left
      this.children[nodeIndex * 2 + 1] = node.right
      this.ranges[nodeIndex * 2] = node.start
      this.ranges[nodeIndex * 2 + 1] = node.count
    }
  }

  get byteLength(): number {
    return (
      this.bounds.byteLength +
      this.children.byteLength +
      this.ranges.byteLength +
      this.triangleOrder.byteLength
    )
  }

  query(bounds: AABB, stats?: MeshQueryStats): Uint32Array {
    if (this.children.length === 0) return new Uint32Array()
    const matches: number[] = []
    const stack = [0]
    let visitedNodes = 0
    let testedTriangles = 0

    while (stack.length > 0) {
      const node = stack.pop()!
      visitedNodes += 1
      if (!nodeIntersects(this.bounds, node, bounds)) continue
      const childOffset = node * 2
      const left = this.children[childOffset]
      const right = this.children[childOffset + 1]
      if (left >= 0) {
        // Push right first so the lower-index child is visited first.
        stack.push(right, left)
        continue
      }

      const start = this.ranges[childOffset]
      const count = this.ranges[childOffset + 1]
      for (let offset = start; offset < start + count; offset += 1) {
        const triangle = this.triangleOrder[offset]
        testedTriangles += 1
        if (triangleIntersects(this.positions, this.triangles, triangle, bounds)) {
          matches.push(triangle)
        }
      }
    }

    // Tree traversal order is an implementation detail. Source triangle order
    // is the stable public result and keeps patches deterministic.
    matches.sort((a, b) => a - b)
    if (stats) {
      stats.visitedNodes = visitedNodes
      stats.testedTriangles = testedTriangles
    }
    return Uint32Array.from(matches)
  }
}

function buildNode(
  nodes: BuildNode[],
  order: number[],
  start: number,
  end: number,
  leafTriangles: number,
  positions: Float32Array,
  triangles: Uint32Array,
): number {
  const nodeIndex = nodes.length
  const bounds = rangeBounds(order, start, end, positions, triangles)
  nodes.push({
    ...bounds,
    left: -1,
    right: -1,
    start,
    count: end - start,
  })
  if (end - start <= leafTriangles) return nodeIndex

  const axis = longestCentroidAxis(order, start, end, positions, triangles)
  const sorted = order.slice(start, end).sort((a, b) => {
    const difference =
      triangleCentroid(positions, triangles, a, axis) -
      triangleCentroid(positions, triangles, b, axis)
    return difference || a - b
  })
  for (let index = 0; index < sorted.length; index += 1) {
    order[start + index] = sorted[index]
  }
  const middle = start + Math.floor((end - start) / 2)
  const left = buildNode(
    nodes,
    order,
    start,
    middle,
    leafTriangles,
    positions,
    triangles,
  )
  const right = buildNode(
    nodes,
    order,
    middle,
    end,
    leafTriangles,
    positions,
    triangles,
  )
  nodes[nodeIndex].left = left
  nodes[nodeIndex].right = right
  nodes[nodeIndex].count = 0
  return nodeIndex
}

function rangeBounds(
  order: number[],
  start: number,
  end: number,
  positions: Float32Array,
  triangles: Uint32Array,
): Omit<BuildNode, 'left' | 'right' | 'start' | 'count'> {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let offset = start; offset < end; offset += 1) {
    const triangleOffset = order[offset] * 3
    for (let corner = 0; corner < 3; corner += 1) {
      const position = triangles[triangleOffset + corner] * 3
      const x = positions[position]
      const y = positions[position + 1]
      const z = positions[position + 2]
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      minZ = Math.min(minZ, z)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      maxZ = Math.max(maxZ, z)
    }
  }
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

function longestCentroidAxis(
  order: number[],
  start: number,
  end: number,
  positions: Float32Array,
  triangles: Uint32Array,
): 0 | 1 | 2 {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let offset = start; offset < end; offset += 1) {
    const triangle = order[offset]
    const x = triangleCentroid(positions, triangles, triangle, 0)
    const y = triangleCentroid(positions, triangles, triangle, 1)
    const z = triangleCentroid(positions, triangles, triangle, 2)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }
  const xExtent = maxX - minX
  const yExtent = maxY - minY
  const zExtent = maxZ - minZ
  if (xExtent >= yExtent && xExtent >= zExtent) return 0
  return yExtent >= zExtent ? 1 : 2
}

function triangleCentroid(
  positions: Float32Array,
  triangles: Uint32Array,
  triangle: number,
  axis: 0 | 1 | 2,
): number {
  const offset = triangle * 3
  return (
    positions[triangles[offset] * 3 + axis] +
    positions[triangles[offset + 1] * 3 + axis] +
    positions[triangles[offset + 2] * 3 + axis]
  ) / 3
}

function nodeIntersects(nodeBounds: Float32Array, node: number, bounds: AABB): boolean {
  const offset = node * 6
  return !(
    nodeBounds[offset + 3] < bounds.min.x ||
    nodeBounds[offset] > bounds.max.x ||
    nodeBounds[offset + 4] < bounds.min.y ||
    nodeBounds[offset + 1] > bounds.max.y ||
    nodeBounds[offset + 5] < bounds.min.z ||
    nodeBounds[offset + 2] > bounds.max.z
  )
}

function triangleIntersects(
  positions: Float32Array,
  triangles: Uint32Array,
  triangle: number,
  bounds: AABB,
): boolean {
  const offset = triangle * 3
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let corner = 0; corner < 3; corner += 1) {
    const position = triangles[offset + corner] * 3
    const x = positions[position]
    const y = positions[position + 1]
    const z = positions[position + 2]
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }
  return !(
    maxX < bounds.min.x ||
    minX > bounds.max.x ||
    maxY < bounds.min.y ||
    minY > bounds.max.y ||
    maxZ < bounds.min.z ||
    minZ > bounds.max.z
  )
}
