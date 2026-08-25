import {
  add,
  clamp,
  hashUnit,
  lerpNumber,
  multiply,
  normalize,
  subtract,
  TreeRandom,
} from '../math'
import type { GrowthNode } from '../crownArchitecture'
import type { SpeciesArchitecture } from '../speciesArchitecture'
import { treeSpeciesDefinition } from '../speciesCatalog'
import type {
  FoliageCluster,
  SemanticTreePart,
  TreeParameters,
  TreeVec3,
} from '../types'

interface Carrier {
  index: number
  weight: number
  priority: number
  cell: string
}

/** Stable upper station budget shared by generation and budget tests. */
export function foliageStationTarget(density: number): number {
  const value = clamp(density, 0, 2)
  return Math.round(value <= 1
    ? lerpNumber(420, 1_500, value)
    : lerpNumber(1_500, 5_000, value - 1))
}

/**
 * Size of one independent foliage-support neighbourhood.
 *
 * A station expands into several cards whose jitter already fills roughly one
 * card diameter. Treating finer growth nodes inside that same volume as
 * independent bearers is what put hundreds of sprays on one apparent twig.
 */
export function foliageAllocationCellSize(
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
): number {
  return Math.max(
    0.3,
    architecture.cardSize * 1.15,
    parameters.crownRadius * 0.04,
  )
}

/** More than one station is a dense local tuft; even hero density stays finite. */
export function foliageAllocationCellCapacity(density: number): number {
  return density > 1.35 ? 3 : 2
}

/**
 * Allocates sprays to unique, spatially distributed fine-growth bearers.
 *
 * The old weighted resampler drew with replacement until it hit a global
 * target as high as 5,000. Sparse trees may expose only a few hundred useful
 * growth nodes, so one favored terminal was selected ten or thirty times; each
 * selection then expanded into several cards. This allocator makes support the
 * hard budget: a node is selected once, every occupied volume gets its first
 * station before any gets a second, and density can never invent leaf mass
 * unsupported by crown wood.
 */
export function allocateColonizedFoliage(
  nodes: readonly GrowthNode[],
  crownParts: readonly SemanticTreePart[],
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
  random: TreeRandom,
): FoliageCluster[] {
  if (parameters.foliageDensity <= 0.01 || nodes.length === 0) return []

  const threshold = architecture.meshedTipRadius * 3.4
  const cellSize = foliageAllocationCellSize(parameters, architecture)
  const carriers: Carrier[] = []

  for (const [index, node] of nodes.entries()) {
    if (node.parent < 0 || node.radius > threshold) continue
    const exposure = clamp(1 - node.occlusion, 0, 1)
    const patch = hashUnit(
      parameters.seed ^ 0x6ac690c5,
      node.position.x * 0.16,
      node.position.y * 0.13,
      node.position.z * 0.16,
    )
    if (patch < 0.16 && node.children.length > 0) continue

    const terminalWeight = node.children.length === 0 ? 2.8 : 0.55
    const weight = terminalWeight *
      lerpNumber(0.18, 1.35, exposure * exposure) *
      lerpNumber(0.28, 1.45, patch * patch)
    // Weighted sampling without replacement. Lower priority wins; the hash is
    // independent of traversal order so adding one twig cannot reshuffle the
    // entire crown.
    const lottery = Math.max(1e-7, hashUnit(
      parameters.seed ^ 0x15d9e377,
      index,
      node.position.x * 0.73,
      node.position.z * 0.61,
    ))
    carriers.push({
      index,
      weight,
      priority: -Math.log(lottery) / Math.max(1e-5, weight),
      cell: spatialCell(node.position, cellSize),
    })
  }
  if (carriers.length === 0) return []

  const byCell = new Map<string, Carrier[]>()
  for (const carrier of carriers) {
    const cell = byCell.get(carrier.cell) ?? []
    cell.push(carrier)
    byCell.set(carrier.cell, cell)
  }
  for (const cell of byCell.values()) {
    cell.sort((a, b) => a.priority - b.priority || a.index - b.index)
  }

  const requested = Math.min(foliageStationTarget(parameters.foliageDensity), carriers.length)
  const capacity = foliageAllocationCellCapacity(parameters.foliageDensity)
  const selected: Carrier[] = []
  // Coverage before concentration: take the best support from every occupied
  // volume before a second support from any volume, then repeat for the optional
  // high-density third layer.
  for (let layer = 0; layer < capacity && selected.length < requested; layer += 1) {
    const round = [...byCell.values()]
      .flatMap((cell) => cell[layer] ? [cell[layer]!] : [])
      .sort((a, b) => a.priority - b.priority || a.index - b.index)
    selected.push(...round.slice(0, requested - selected.length))
  }
  selected.sort((a, b) => a.index - b.index)

  const organModel = treeSpeciesDefinition(parameters.species).organModel
  return selected.map((carrier, outputIndex) => {
    const node = nodes[carrier.index]!
    const parent = nodes[node.parent]!
    const axis = normalize(subtract(node.position, parent.position), node.direction)
    const scale = random.range(0.82, 1.28)
    const radius = architecture.cardSize * scale
    return {
      id: `foliage-${outputIndex + 1}`,
      // Fine growth nodes below the meshing threshold are not semantic parts.
      // Bind metadata to the nearest retained carrier instead of manufacturing
      // a `growth-N` id that does not exist in the graph.
      partId: nearestBearerId(node.position, crownParts),
      center: add(node.position, multiply(axis, radius * 0.32)),
      axis,
      radius,
      depth: radius * random.range(0.78, 1.22),
      occlusion: node.occlusion,
      organModel,
      seed: Math.floor(random.unit() * 0x7fffffff),
    }
  })
}

function spatialCell(position: TreeVec3, size: number): string {
  return `${Math.floor(position.x / size)},${Math.floor(position.y / size)},${Math.floor(position.z / size)}`
}

function nearestBearerId(
  position: TreeVec3,
  parts: readonly SemanticTreePart[],
): string {
  let bestId = parts[0]?.id ?? 'trunk'
  let bestDistance = Infinity
  for (const part of parts) {
    if (part.spine.length === 1) {
      const distance = squaredDistance(position, part.spine[0]!.position)
      if (distance < bestDistance) {
        bestDistance = distance
        bestId = part.id
      }
      continue
    }
    for (let index = 1; index < part.spine.length; index += 1) {
      const distance = squaredDistanceToSegment(
        position,
        part.spine[index - 1]!.position,
        part.spine[index]!.position,
      )
      if (distance < bestDistance) {
        bestDistance = distance
        bestId = part.id
      }
    }
  }
  return bestId
}

function squaredDistance(a: TreeVec3, b: TreeVec3): number {
  const x = a.x - b.x
  const y = a.y - b.y
  const z = a.z - b.z
  return x * x + y * y + z * z
}

function squaredDistanceToSegment(
  point: TreeVec3,
  start: TreeVec3,
  end: TreeVec3,
): number {
  const x = end.x - start.x
  const y = end.y - start.y
  const z = end.z - start.z
  const lengthSquared = x * x + y * y + z * z
  if (lengthSquared < 1e-10) return squaredDistance(point, start)
  const amount = clamp(
    ((point.x - start.x) * x + (point.y - start.y) * y +
      (point.z - start.z) * z) / lengthSquared,
    0,
    1,
  )
  return squaredDistance(point, {
    x: start.x + x * amount,
    y: start.y + y * amount,
    z: start.z + z * amount,
  })
}
