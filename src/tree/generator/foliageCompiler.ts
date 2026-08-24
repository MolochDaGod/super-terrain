import {
  add,
  clamp,
  cross,
  hashUnit,
  lerpNumber,
  multiply,
  normalize,
  subtract,
  TreeRandom,
  vec3,
} from './math'
import { speciesArchitecture, type SpeciesArchitecture } from './speciesArchitecture'
import type {
  FoliageCluster,
  SemanticTreeGraph,
  TreeFoliageData,
  TreeLodLevel,
  TreeParameters,
  TreeVec3,
} from './types'

/** Distinct sprays in the leaf atlas; each becomes its own instanced batch. */
export const LEAF_CARD_VARIANTS = 4

/**
 * Crown foliage as leaf *cards*.
 *
 * One quad per leaf is the wrong primitive at this scale: an oak carries on the
 * order of a hundred thousand leaves, so a per-leaf crown is either unaffordable
 * or — at an affordable count — visible confetti with air between every leaf.
 * Every shipped game tree instead draws pre-composed sprays: a card holding a
 * whole twiglet of leaves, placed on the branchlets that actually carry them.
 *
 * Two things make the cards read as a volume rather than as stickers. Each card
 * is bowed and carries fanned normals, and each is turned so that fan points out
 * of the crown — together that lights the canopy as one soft mass. And each card
 * is tinted by how deep in the crown it sits, which is what gives the interior a
 * dark core instead of the uniform flat green of a card cloud.
 */
export function compileFoliage(
  graph: SemanticTreeGraph,
  parameters: TreeParameters,
  level: TreeLodLevel,
): TreeFoliageData {
  if (parameters.foliageDensity <= 0.01 || graph.foliageClusters.length === 0) {
    return emptyFoliage(level)
  }
  const architecture = speciesArchitecture(parameters)
  return level === 2
    ? compileClusterInstances(graph, parameters, architecture)
    : compileCardInstances(graph, parameters, architecture, level)
}

function compileCardInstances(
  graph: SemanticTreeGraph,
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
  level: 0 | 1,
): TreeFoliageData {
  const matrices: number[] = []
  const colors: number[] = []
  const variants: number[] = []
  const crownCenter = crownCentroid(graph.foliageClusters)
  const perStation = level === 0
    ? architecture.cardsPerStation
    : Math.max(1, Math.round(architecture.cardsPerStation * 0.5))
  // A medium LOD draws fewer, larger cards so the crown keeps its mass instead
  // of turning to lace the moment the count drops.
  const sizeCompensation = level === 0
    ? 1
    : Math.sqrt(architecture.cardsPerStation / Math.max(1, perStation))

  for (const cluster of graph.foliageClusters) {
    const random = new TreeRandom(cluster.seed + level * 7919)
    // Outward from the crown's own centre, not from the world axis: on a
    // lopsided veteran the two are metres apart and the axis version lights the
    // overhanging side as if it faced inward.
    const outward = normalize(subtract(cluster.center, crownCenter), vec3(0, 1, 0))
    for (let index = 0; index < perStation; index += 1) {
      const jitter = vec3(
        random.signed() * cluster.radius * 0.42,
        random.signed() * cluster.radius * 0.34,
        random.signed() * cluster.radius * 0.42,
      )
      const position = add(cluster.center, jitter)
      // The card's own up follows the twig it hangs from, so sprays droop and
      // splay with the branchlet instead of all standing to attention.
      const up = normalize(
        add(cluster.axis, multiply(randomUnit(random), 0.42)),
        cluster.axis,
      )
      const facing = normalize(
        add(outward, multiply(randomUnit(random), 0.3)),
        outward,
      )
      const right = normalize(cross(up, facing), vec3(1, 0, 0))
      const normal = normalize(cross(right, up), facing)
      const size = cluster.radius * random.range(0.82, 1.24) * sizeCompensation
      appendMatrix(
        matrices,
        right,
        up,
        normal,
        position,
        size,
        size * random.range(0.92, 1.3),
        size,
      )
      appendCardColour(colors, parameters, architecture, cluster, position, index)
      variants.push(
        Math.floor(hashUnit(cluster.seed, index, position.y, parameters.seed) *
          LEAF_CARD_VARIANTS) % LEAF_CARD_VARIANTS,
      )
    }
  }
  return {
    representation: 'cards',
    matrices: Float32Array.from(matrices),
    colors: Float32Array.from(colors),
    variants: Uint8Array.from(variants),
    variantCount: LEAF_CARD_VARIANTS,
    count: matrices.length / 16,
  }
}

/** Far LOD: the crown collapses to a handful of tinted blobs. */
function compileClusterInstances(
  graph: SemanticTreeGraph,
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
): TreeFoliageData {
  const matrices: number[] = []
  const colors: number[] = []
  const variants: number[] = []
  const clusters = graph.foliageClusters
  const stride = Math.max(1, Math.round(clusters.length / 120))
  for (let index = 0; index < clusters.length; index += stride) {
    const cluster = clusters[index]!
    // Hero sprays were reduced to branchlet scale, but far clusters still need
    // the original broad footprint or the capped ~120 blobs turn the crown to
    // lace. Preserve each station's authored size jitter while restoring that
    // species-specific far silhouette.
    const scale = cluster.radius / architecture.cardSize *
      architecture.farClusterSize * 2.6
    appendMatrix(
      matrices,
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, 0, 1),
      cluster.center,
      scale,
      scale * 0.82,
      scale,
    )
    appendCardColour(
      colors,
      parameters,
      architecture,
      cluster,
      cluster.center,
      index,
    )
    variants.push(0)
  }
  return {
    representation: 'clusters',
    matrices: Float32Array.from(matrices),
    colors: Float32Array.from(colors),
    variants: Uint8Array.from(variants),
    variantCount: 1,
    count: matrices.length / 16,
  }
}

function crownCentroid(clusters: readonly FoliageCluster[]): TreeVec3 {
  if (clusters.length === 0) return vec3(0, 0, 0)
  let sum = vec3(0, 0, 0)
  for (const cluster of clusters) sum = add(sum, cluster.center)
  return multiply(sum, 1 / clusters.length)
}

/**
 * Per-card tint. This is a *multiplier* on the atlas albedo, not a colour in its
 * own right: the atlas already carries the leaf green, and handing the instance
 * an absolute dark green as well multiplied the two and left the whole crown
 * several stops under.
 *
 * Occlusion is the important term. Without it every card in the crown is the
 * same value and the canopy has no depth read at all, however good the leaf art
 * and the lighting are.
 */
function appendCardColour(
  target: number[],
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
  cluster: FoliageCluster,
  position: TreeVec3,
  index: number,
): void {
  const variation = hashUnit(cluster.seed, index, position.y, parameters.seed)
  const exposure = Math.pow(clamp(1 - cluster.occlusion, 0, 1), 1.3)
  // Shade leaves are not merely darker: they are bluer and less saturated, and
  // sun leaves carry a yellow flush. Both are free here and both are what the
  // eye reads as canopy depth.
  const value = lerpNumber(architecture.shadeValue, architecture.sunValue, exposure)
  const warmth = lerpNumber(-0.12, 0.1, exposure) + variation * 0.09 - 0.045
  target.push(
    clamp(value * (1 + warmth * 1.1), 0, 2),
    clamp(value * (1 + warmth * 0.3), 0, 2),
    clamp(value * (1 - warmth * 0.9), 0, 2),
  )
}

function randomUnit(random: TreeRandom): TreeVec3 {
  const z = random.signed()
  const azimuth = random.range(0, Math.PI * 2)
  const ring = Math.sqrt(Math.max(0, 1 - z * z))
  return vec3(Math.cos(azimuth) * ring, z, Math.sin(azimuth) * ring)
}

function emptyFoliage(level: TreeLodLevel): TreeFoliageData {
  return {
    representation: level === 2 ? 'clusters' : 'cards',
    matrices: new Float32Array(),
    colors: new Float32Array(),
    variants: new Uint8Array(),
    variantCount: 1,
    count: 0,
  }
}

function appendMatrix(
  target: number[],
  xAxis: TreeVec3,
  yAxis: TreeVec3,
  zAxis: TreeVec3,
  position: TreeVec3,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
): void {
  target.push(
    xAxis.x * scaleX,
    xAxis.y * scaleX,
    xAxis.z * scaleX,
    0,
    yAxis.x * scaleY,
    yAxis.y * scaleY,
    yAxis.z * scaleY,
    0,
    zAxis.x * scaleZ,
    zAxis.y * scaleZ,
    zAxis.z * scaleZ,
    0,
    position.x,
    position.y,
    position.z,
    1,
  )
}
