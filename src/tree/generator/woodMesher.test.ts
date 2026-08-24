import { describe, expect, it } from 'vitest'
import { generateSemanticTree } from './semanticGraph'
import {
  DEFAULT_TREE_ENVIRONMENT,
  DEFAULT_TREE_PARAMETERS,
  type TreeMeshData,
} from './types'
import { compileWoodyMesh } from './woodMesher'

const TEST_PARAMETERS = {
  ...DEFAULT_TREE_PARAMETERS,
  seed: 73129,
  branchCount: 6,
  rootCount: 5,
  foliageDensity: 0.25,
}

describe('adaptive woody topology compiler', () => {
  it('generates closed, indexed, non-degenerate budgeted topology at every direct LOD', () => {
    const graph = generateSemanticTree(TEST_PARAMETERS, DEFAULT_TREE_ENVIRONMENT)
    const compiled = ([0, 1, 2] as const).map((level) => compileWoodyMesh(graph, level))
    const lods = compiled.map(({ mesh }) => mesh)

    expect(lods[0].indices.length).toBeGreaterThan(lods[1].indices.length)
    expect(lods[1].indices.length).toBeGreaterThan(lods[2].indices.length)
    expect(lods[0].indices.length / 3).toBeLessThanOrEqual(110_000)
    expect(lods[1].indices.length / 3).toBeLessThanOrEqual(34_000)
    expect(lods[2].indices.length / 3).toBeLessThanOrEqual(6_000)

    for (const [index, mesh] of lods.entries()) {
      expect(mesh.positions.length / 3).toBeLessThan(mesh.indices.length)
      let maximumIndex = 0
      for (const index of mesh.indices) maximumIndex = Math.max(maximumIndex, index)
      expect(maximumIndex).toBeLessThan(mesh.positions.length / 3)
      const topology = analyzeTopology(mesh)
      expect(topology.boundaryEdges).toBe(0)
      expect(topology.nonManifoldEdges).toBe(0)
      // The trunk and its continuation share rings. Lateral collars are closed,
      // independent game-ready shells so they can be edited or culled by part.
      expect(topology.components).toBe(compiled[index]!.includedPartCount - 1)
      expect(topology.minimumAreaSquared).toBeGreaterThan(1e-20)
      expect(topology.signedVolume).toBeGreaterThan(0)
    }
  }, 20_000)

  it('recompiles a selected LOD byte-for-byte from the cached semantic graph', () => {
    const graph = generateSemanticTree(TEST_PARAMETERS, DEFAULT_TREE_ENVIRONMENT)
    const first = compileWoodyMesh(graph, 2).mesh
    const second = compileWoodyMesh(graph, 2).mesh
    expect(second.positions).toEqual(first.positions)
    expect(second.normals).toEqual(first.normals)
    expect(second.colors).toEqual(first.colors)
    expect(second.indices).toEqual(first.indices)
  }, 10_000)

  it('preserves the major silhouette instead of collapsing the far LOD', () => {
    const graph = generateSemanticTree(TEST_PARAMETERS, DEFAULT_TREE_ENVIRONMENT)
    const hero = compileWoodyMesh(graph, 0).mesh
    const far = compileWoodyMesh(graph, 2).mesh
    const heroHeight = hero.bounds.max.y - hero.bounds.min.y
    const farHeight = far.bounds.max.y - far.bounds.min.y
    const heroWidth = hero.bounds.max.x - hero.bounds.min.x
    const farWidth = far.bounds.max.x - far.bounds.min.x
    expect(farHeight / heroHeight).toBeGreaterThan(0.9)
    expect(farWidth / heroWidth).toBeGreaterThan(0.78)
  }, 20_000)

  it('keeps a six-turn fused bole closed and inside the hero budget', () => {
    const graph = generateSemanticTree(
      { ...TEST_PARAMETERS, boleForm: 'fused', twist: 6 },
      DEFAULT_TREE_ENVIRONMENT,
    )
    const { mesh } = compileWoodyMesh(graph, 0)
    const topology = analyzeTopology(mesh)
    expect(mesh.indices.length / 3).toBeLessThanOrEqual(110_000)
    expect(topology.boundaryEdges).toBe(0)
    expect(topology.nonManifoldEdges).toBe(0)
    expect(topology.minimumAreaSquared).toBeGreaterThan(1e-20)
  }, 20_000)
})

function analyzeTopology(mesh: TreeMeshData) {
  const edges = new Map<string, number>()
  const parents = new Uint32Array(mesh.positions.length / 3)
  for (let vertex = 0; vertex < parents.length; vertex += 1) parents[vertex] = vertex
  let minimumAreaSquared = Infinity
  let signedVolume = 0
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset]!
    const b = mesh.indices[offset + 1]!
    const c = mesh.indices[offset + 2]!
    union(parents, a, b)
    union(parents, b, c)
    for (const [left, right] of [[a, b], [b, c], [c, a]]) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
    const pa = vertex(mesh.positions, a)
    const pb = vertex(mesh.positions, b)
    const pc = vertex(mesh.positions, c)
    const ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]
    const ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ]
    minimumAreaSquared = Math.min(
      minimumAreaSquared,
      normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2,
    )
    signedVolume += pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) +
      pa[1] * (pb[2] * pc[0] - pb[0] * pc[2]) +
      pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])
  }
  let boundaryEdges = 0
  let nonManifoldEdges = 0
  for (const count of edges.values()) {
    if (count === 1) boundaryEdges += 1
    else if (count !== 2) nonManifoldEdges += 1
  }
  const components = new Set<number>()
  for (let vertex = 0; vertex < parents.length; vertex += 1) {
    components.add(find(parents, vertex))
  }
  return {
    boundaryEdges,
    nonManifoldEdges,
    components: components.size,
    minimumAreaSquared,
    signedVolume: signedVolume / 6,
  }
}

function vertex(positions: Float32Array, index: number): [number, number, number] {
  const offset = index * 3
  return [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!]
}

function find(parents: Uint32Array, value: number): number {
  let root = value
  while (parents[root] !== root) root = parents[root]!
  let current = value
  while (parents[current] !== current) {
    const next = parents[current]!
    parents[current] = root
    current = next
  }
  return root
}

function union(parents: Uint32Array, a: number, b: number): void {
  const rootA = find(parents, a)
  const rootB = find(parents, b)
  if (rootA !== rootB) parents[rootB] = rootA
}
