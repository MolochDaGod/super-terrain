import type { GraniteSurface } from './dualContourGranite'

interface EdgeOccurrence {
  triangle: number
  from: number
  to: number
}

function edgeKey(a: number, b: number): number {
  return a < b ? a * 4294967 + b : b * 4294967 + a
}

function removeNonManifoldFins(
  indices: Uint32Array,
  positions: Float64Array,
): Uint32Array {
  const triangleCount = indices.length / 3
  const area = new Float64Array(triangleCount)
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = indices[triangle * 3]!
    const b = indices[triangle * 3 + 1]!
    const c = indices[triangle * 3 + 2]!
    const abx = positions[b * 3]! - positions[a * 3]!
    const aby = positions[b * 3 + 1]! - positions[a * 3 + 1]!
    const abz = positions[b * 3 + 2]! - positions[a * 3 + 2]!
    const acx = positions[c * 3]! - positions[a * 3]!
    const acy = positions[c * 3 + 1]! - positions[a * 3 + 1]!
    const acz = positions[c * 3 + 2]! - positions[a * 3 + 2]!
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    area[triangle] = Math.sqrt(nx * nx + ny * ny + nz * nz)
  }
  const order = Array.from({ length: triangleCount }, (_, index) => index)
    .sort((left, right) => area[right]! - area[left]!)
  const edgeUse = new Map<number, number>()
  const alive = new Uint8Array(triangleCount)
  for (const triangle of order) {
    const a = indices[triangle * 3]!
    const b = indices[triangle * 3 + 1]!
    const c = indices[triangle * 3 + 2]!
    if (a === b || b === c || c === a || area[triangle]! < 1e-14) continue
    const directedEdges = [[a, b], [b, c], [c, a]] as const
    const slots = directedEdges.map(([from, to]) => ({
      key: edgeKey(from, to),
      direction: from < to ? 1 : 2,
    }))
    if (slots.some(({ key, direction }) => ((edgeUse.get(key) ?? 0) & direction) !== 0)) {
      continue
    }
    for (const { key, direction } of slots) {
      edgeUse.set(key, (edgeUse.get(key) ?? 0) | direction)
    }
    alive[triangle] = 1
  }
  const kept: number[] = []
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (!alive[triangle]) continue
    kept.push(
      indices[triangle * 3]!,
      indices[triangle * 3 + 1]!,
      indices[triangle * 3 + 2]!,
    )
  }
  return new Uint32Array(kept)
}

function keepLargestComponent(indices: Uint32Array): Uint32Array {
  const triangleCount = indices.length / 3
  const edgeTriangles = new Map<number, number[]>()
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let edge = 0; edge < 3; edge += 1) {
      const a = indices[triangle * 3 + edge]!
      const b = indices[triangle * 3 + ((edge + 1) % 3)]!
      const key = edgeKey(a, b)
      const bucket = edgeTriangles.get(key)
      if (bucket) bucket.push(triangle)
      else edgeTriangles.set(key, [triangle])
    }
  }
  const component = new Int32Array(triangleCount).fill(-1)
  let bestLabel = -1
  let bestSize = -1
  let label = 0
  for (let seed = 0; seed < triangleCount; seed += 1) {
    if (component[seed] !== -1) continue
    const currentLabel = label++
    const queue = [seed]
    component[seed] = currentLabel
    let cursor = 0
    while (cursor < queue.length) {
      const triangle = queue[cursor++]!
      for (let edge = 0; edge < 3; edge += 1) {
        const a = indices[triangle * 3 + edge]!
        const b = indices[triangle * 3 + ((edge + 1) % 3)]!
        for (const neighbor of edgeTriangles.get(edgeKey(a, b)) ?? []) {
          if (component[neighbor] !== -1) continue
          component[neighbor] = currentLabel
          queue.push(neighbor)
        }
      }
    }
    if (queue.length > bestSize) {
      bestSize = queue.length
      bestLabel = currentLabel
    }
  }
  const kept: number[] = []
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (component[triangle] !== bestLabel) continue
    kept.push(
      indices[triangle * 3]!,
      indices[triangle * 3 + 1]!,
      indices[triangle * 3 + 2]!,
    )
  }
  return new Uint32Array(kept)
}

function splitEulerCircuit(circuit: number[]): number[][] {
  const remaining = circuit.slice()
  const cycles: number[][] = []
  while (remaining.length > 1) {
    const seen = new Map<number, number>()
    let found = false
    for (let index = 0; index < remaining.length; index += 1) {
      const vertex = remaining[index]!
      const previous = seen.get(vertex)
      if (previous === undefined) {
        seen.set(vertex, index)
        continue
      }
      const cycle = remaining.slice(previous, index + 1)
      if (cycle.length >= 4) cycles.push(cycle)
      remaining.splice(previous + 1, index - previous)
      found = true
      break
    }
    if (!found) break
  }
  return cycles
}

function capBoundaryCycles(
  indices: Uint32Array,
  positions: Float64Array,
): { indices: Uint32Array; positions: Float64Array } {
  const use = new Map<number, number>()
  const direction = new Map<number, readonly [number, number]>()
  for (let offset = 0; offset < indices.length; offset += 3) {
    for (let edge = 0; edge < 3; edge += 1) {
      const a = indices[offset + edge]!
      const b = indices[offset + ((edge + 1) % 3)]!
      const key = edgeKey(a, b)
      use.set(key, (use.get(key) ?? 0) + 1)
      direction.set(key, [a, b])
    }
  }
  const boundaries: Array<readonly [number, number]> = []
  const adjacency = new Map<number, number[]>()
  for (const [key, count] of use) {
    if (count !== 1) continue
    const edge = direction.get(key)!
    const edgeIndex = boundaries.length
    boundaries.push(edge)
    const bucket = adjacency.get(edge[0])
    if (bucket) bucket.push(edgeIndex)
    else adjacency.set(edge[0], [edgeIndex])
  }
  if (boundaries.length === 0) return { indices, positions }

  const balance = new Map<number, number>()
  for (const [from, to] of boundaries) {
    balance.set(from, (balance.get(from) ?? 0) + 1)
    balance.set(to, (balance.get(to) ?? 0) - 1)
  }
  const imbalanced = [...balance].find(([, value]) => value !== 0)
  if (imbalanced) {
    throw new Error(`Imbalanced granite boundary vertex ${imbalanced[0]}:${imbalanced[1]}`)
  }

  const used = new Uint8Array(boundaries.length)
  const circuits: number[][] = []
  for (let seed = 0; seed < boundaries.length; seed += 1) {
    if (used[seed]) continue
    const start = boundaries[seed]![0]
    const stack = [start]
    const circuit: number[] = []
    while (stack.length > 0) {
      const vertex = stack[stack.length - 1]!
      const nextEdge = (adjacency.get(vertex) ?? []).find((edge) => !used[edge])
      if (nextEdge === undefined) {
        circuit.push(stack.pop()!)
        continue
      }
      used[nextEdge] = 1
      stack.push(boundaries[nextEdge]![1])
    }
    circuit.reverse()
    circuits.push(...splitEulerCircuit(circuit))
  }

  const extraPositions: number[] = []
  const added: number[] = []
  const originalVertexCount = positions.length / 3
  for (const cycle of circuits) {
    const vertices = cycle.slice(0, -1)
    let x = 0
    let y = 0
    let z = 0
    for (const vertex of vertices) {
      x += positions[vertex * 3]!
      y += positions[vertex * 3 + 1]!
      z += positions[vertex * 3 + 2]!
    }
    const centroid = originalVertexCount + extraPositions.length / 3
    extraPositions.push(x / vertices.length, y / vertices.length, z / vertices.length)
    for (let index = 0; index < vertices.length; index += 1) {
      const a = vertices[index]!
      const b = vertices[(index + 1) % vertices.length]!
      const owner = direction.get(edgeKey(a, b))
      if (!owner) {
        throw new Error(`Invalid granite boundary cycle edge ${a}:${b}`)
      }
      added.push(centroid, owner[1], owner[0])
    }
  }
  const outputIndices = new Uint32Array(indices.length + added.length)
  outputIndices.set(indices)
  outputIndices.set(added, indices.length)
  const outputPositions = new Float64Array(positions.length + extraPositions.length)
  outputPositions.set(positions)
  outputPositions.set(extraPositions, positions.length)
  return { indices: outputIndices, positions: outputPositions }
}

function orientConsistently(indices: Uint32Array): void {
  const triangleCount = indices.length / 3
  const occurrences = new Map<number, EdgeOccurrence[]>()
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let edge = 0; edge < 3; edge += 1) {
      const from = indices[triangle * 3 + edge]!
      const to = indices[triangle * 3 + ((edge + 1) % 3)]!
      const key = edgeKey(from, to)
      const bucket = occurrences.get(key)
      const occurrence = { triangle, from, to }
      if (bucket) bucket.push(occurrence)
      else occurrences.set(key, [occurrence])
    }
  }
  const neighbors: Array<Array<{ triangle: number; toggle: boolean }>> =
    Array.from({ length: triangleCount }, () => [])
  for (const bucket of occurrences.values()) {
    if (bucket.length !== 2) continue
    const [left, right] = bucket
    const toggle = left!.from === right!.from && left!.to === right!.to
    neighbors[left!.triangle]!.push({ triangle: right!.triangle, toggle })
    neighbors[right!.triangle]!.push({ triangle: left!.triangle, toggle })
  }
  const orientation = new Int8Array(triangleCount).fill(-1)
  for (let seed = 0; seed < triangleCount; seed += 1) {
    if (orientation[seed] !== -1) continue
    orientation[seed] = 0
    const queue = [seed]
    let cursor = 0
    while (cursor < queue.length) {
      const current = queue[cursor++]!
      for (const neighbor of neighbors[current]!) {
        const expected = orientation[current]! ^ Number(neighbor.toggle)
        if (orientation[neighbor.triangle] !== -1) continue
        orientation[neighbor.triangle] = expected
        queue.push(neighbor.triangle)
      }
    }
  }
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (orientation[triangle] !== 1) continue
    const offset = triangle * 3
    const temporary = indices[offset + 1]!
    indices[offset + 1] = indices[offset + 2]!
    indices[offset + 2] = temporary
  }
}

/**
 * Edge-manifold meshes can still contain a bow-tie vertex where independent
 * surface fans touch at one index. Duplicate that index per disconnected fan;
 * positions stay identical, while the topology becomes a true two-manifold.
 */
function splitNonManifoldVertices(
  indices: Uint32Array,
  positions: Float64Array,
): { indices: Uint32Array; positions: Float64Array } {
  const vertexCount = positions.length / 3
  const incident: number[][] = Array.from({ length: vertexCount }, () => [])
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    incident[indices[triangle * 3]!]!.push(triangle)
    incident[indices[triangle * 3 + 1]!]!.push(triangle)
    incident[indices[triangle * 3 + 2]!]!.push(triangle)
  }
  const output = new Uint32Array(indices)
  const extraPositions: number[] = []
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const triangles = incident[vertex]!
    if (triangles.length < 2) continue
    const aroundEdge = new Map<number, number[]>()
    for (const triangle of triangles) {
      const offset = triangle * 3
      for (let corner = 0; corner < 3; corner += 1) {
        const other = output[offset + corner]!
        if (other === vertex) continue
        const bucket = aroundEdge.get(other)
        if (bucket) bucket.push(triangle)
        else aroundEdge.set(other, [triangle])
      }
    }
    const neighbors = new Map<number, number[]>()
    for (const bucket of aroundEdge.values()) {
      for (const triangle of bucket) {
        const list = neighbors.get(triangle) ?? []
        for (const other of bucket) {
          if (other !== triangle) list.push(other)
        }
        neighbors.set(triangle, list)
      }
    }
    const remaining = new Set(triangles)
    const components: number[][] = []
    while (remaining.size > 0) {
      const seed = remaining.values().next().value as number
      remaining.delete(seed)
      const component = [seed]
      let cursor = 0
      while (cursor < component.length) {
        for (const neighbor of neighbors.get(component[cursor++]!) ?? []) {
          if (!remaining.delete(neighbor)) continue
          component.push(neighbor)
        }
      }
      components.push(component)
    }
    for (let component = 1; component < components.length; component += 1) {
      const duplicate = vertexCount + extraPositions.length / 3
      extraPositions.push(
        positions[vertex * 3]!,
        positions[vertex * 3 + 1]!,
        positions[vertex * 3 + 2]!,
      )
      for (const triangle of components[component]!) {
        const offset = triangle * 3
        for (let corner = 0; corner < 3; corner += 1) {
          if (output[offset + corner] === vertex) output[offset + corner] = duplicate
        }
      }
    }
  }
  if (extraPositions.length === 0) return { indices: output, positions }
  const outputPositions = new Float64Array(positions.length + extraPositions.length)
  outputPositions.set(positions)
  outputPositions.set(extraPositions, positions.length)
  return { indices: output, positions: outputPositions }
}

function signedVolume(positions: Float64Array, indices: Uint32Array): number {
  let volume = 0
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]! * 3
    const b = indices[offset + 1]! * 3
    const c = indices[offset + 2]! * 3
    volume += positions[a]! *
      (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!) +
      positions[a + 1]! *
      (positions[b + 2]! * positions[c]! - positions[b]! * positions[c + 2]!) +
      positions[a + 2]! *
      (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!)
  }
  return volume / 6
}

function compactSurface(
  positions: Float64Array,
  indices: Uint32Array,
): { positions: Float64Array; indices: Uint32Array } {
  const remap = new Int32Array(positions.length / 3).fill(-1)
  const compactedPositions: number[] = []
  const compactedIndices = new Uint32Array(indices.length)
  for (let offset = 0; offset < indices.length; offset += 1) {
    const source = indices[offset]!
    let target = remap[source]!
    if (target === -1) {
      target = compactedPositions.length / 3
      remap[source] = target
      compactedPositions.push(
        positions[source * 3]!,
        positions[source * 3 + 1]!,
        positions[source * 3 + 2]!,
      )
    }
    compactedIndices[offset] = target
  }
  return {
    positions: new Float64Array(compactedPositions),
    indices: compactedIndices,
  }
}

export function repairGraniteSurface(surface: GraniteSurface): GraniteSurface {
  const manifold = removeNonManifoldFins(surface.indices, surface.positions)
  const connected = keepLargestComponent(manifold)
  orientConsistently(connected)
  const capped = capBoundaryCycles(connected, surface.positions)
  const split = splitNonManifoldVertices(capped.indices, capped.positions)
  orientConsistently(split.indices)
  if (signedVolume(split.positions, split.indices) < 0) {
    for (let offset = 0; offset < split.indices.length; offset += 3) {
      const temporary = split.indices[offset + 1]!
      split.indices[offset + 1] = split.indices[offset + 2]!
      split.indices[offset + 2] = temporary
    }
  }
  const compacted = compactSurface(split.positions, split.indices)
  return {
    positions: compacted.positions,
    normals: new Float64Array(compacted.positions.length),
    indices: compacted.indices,
  }
}
