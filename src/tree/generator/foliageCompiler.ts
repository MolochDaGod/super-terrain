import {
  add,
  clamp,
  cross,
  dot,
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
export const LEAF_CARD_VARIANTS = 8
/** Spears plus enough mature cohorts that a palm crown does not repeat six meshes. */
export const FROND_GEOMETRY_VARIANTS = 16

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
  return compileCardInstances(graph, parameters, architecture, level)
}

function compileCardInstances(
  graph: SemanticTreeGraph,
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
  level: TreeLodLevel,
): TreeFoliageData {
  const matrices: number[] = []
  const colors: number[] = []
  const variants: number[] = []
  const crownCenter = crownCentroid(graph.foliageClusters)
  // Card count, not merely cards-per-station, is what dominates a forest.
  // Keep a spatially distributed subset of stations at distance: every item
  // is still genuine authored foliage, but sub-pixel branchlet sprays are not
  // submitted hundreds of times per tree.
  const stationBudget = level === 0 ? Number.POSITIVE_INFINITY : level === 1 ? 560 : 112
  const stationStride = Math.max(
    1,
    Math.ceil(graph.foliageClusters.length / stationBudget),
  )
  const perStation = level === 0
    ? architecture.cardsPerStation
    : level === 1
      ? Math.max(1, Math.round(architecture.cardsPerStation * 0.5))
      : Math.max(1, Math.round(architecture.cardsPerStation * 0.18))
  // Lower LODs draw fewer, larger sprays. Even the far representation remains
  // real alpha-cut leaf/frond geometry; it only reduces the number of cards.
  const sizeCompensation = level === 0
    ? 1
    : Math.min(level === 1 ? 1.55 : 1.9,
        Math.sqrt(architecture.cardsPerStation / Math.max(1, perStation)))
  const frondGeometry = parameters.species === 'doum-palm' ? 'fan-frond' : 'frond'

  for (let clusterIndex = 0; clusterIndex < graph.foliageClusters.length; clusterIndex += stationStride) {
    const cluster = graph.foliageClusters[clusterIndex]!
    const random = new TreeRandom(cluster.seed + level * 7919)
    // Outward from the crown's own centre, not from the world axis: on a
    // lopsided veteran the two are metres apart and the axis version lights the
    // overhanging side as if it faced inward.
    const outward = normalize(subtract(cluster.center, crownCenter), vec3(0, 1, 0))
    const organCount = cluster.organModel === 'frond' || cluster.organModel === 'terminal-rosette'
      ? 1
      : perStation
    for (let index = 0; index < organCount; index += 1) {
      const jitter = cluster.organModel === 'frond' || cluster.organModel === 'terminal-rosette'
        ? vec3()
        : vec3(
            random.signed() * cluster.radius * 0.42,
            random.signed() * cluster.radius * 0.34,
            random.signed() * cluster.radius * 0.42,
          )
      const position = add(cluster.center, jitter)
      // The card's own up follows the twig it hangs from, so sprays droop and
      // splay with the branchlet instead of all standing to attention.
      const up = cluster.organModel === 'frond'
        ? normalize(cluster.axis, vec3(0, 1, 0))
        : cluster.organModel === 'terminal-rosette'
        ? normalize(cluster.axis, vec3(0, 1, 0))
        : cluster.organModel === 'broadleaf-spray'
          // A spray is borne by the twig, but it is not a billboard extruded
          // along that twig.  Blending a broad spherical splay with a mild
          // upward bias breaks the vertical ribbons produced by emergent
          // shoots while keeping neighbouring cards in one crown volume.
          ? normalize(
              add(
                multiply(cluster.axis, 0.28),
                add(multiply(randomUnit(random), 0.78), vec3(0, 0.24, 0)),
              ),
              cluster.axis,
            )
        : normalize(
            add(cluster.axis, multiply(randomUnit(random), 0.42)),
            cluster.axis,
          )
      // A frond card's plane contains its radial rachis. Its normal is the
      // world-up vector projected perpendicular to that rachis, so the basis
      // can never collapse when crown-centre outward and frond direction are
      // parallel (the exact singularity that produced needle-thin fireworks).
      const frondNormal = normalize(
        subtract(vec3(0, 1, 0), multiply(up, dot(vec3(0, 1, 0), up))),
        normalize(cross(up, vec3(0, 1, 0)), vec3(0, 0, 1)),
      )
      const facing = cluster.organModel === 'frond'
        ? frondNormal
        : normalize(
            add(
              outward,
              multiply(
                randomUnit(random),
                cluster.organModel === 'broadleaf-spray' ? 0.7 : 0.3,
              ),
            ),
            outward,
          )
      const baseRight = normalize(cross(up, facing), vec3(1, 0, 0))
      const baseNormal = normalize(cross(baseRight, up), facing)
      // Successive palm leaves emerge with small changes in roll. Keeping all
      // rachis planes level produced the synthetic umbrella/fishbone read even
      // after the mesh itself was folded.
      const roll = cluster.organModel === 'frond' ? random.signed() * 0.24 : 0
      const right = normalize(add(
        multiply(baseRight, Math.cos(roll)),
        multiply(baseNormal, Math.sin(roll)),
      ), baseRight)
      const normal = normalize(add(
        multiply(baseNormal, Math.cos(roll)),
        multiply(baseRight, -Math.sin(roll)),
      ), baseNormal)
      const size = cluster.radius * random.range(0.82, 1.24) * sizeCompensation
      const fanFrond = frondGeometry === 'fan-frond' && cluster.organModel === 'frond'
      const scaleX = cluster.organModel === 'frond'
        // `cluster.radius` is the half-width of the whole compound frond. The
        // card geometry spans one local unit, so it needs roughly twice that
        // authored radius; the old 0.48 multiplier encoded four-metre date
        // fronds as 20-centimetre needles.
        ? size * (fanFrond ? 3.15 : 1.9)
        : cluster.organModel === 'terminal-rosette' ? size : size
      const scaleY = cluster.organModel === 'frond'
        ? cluster.depth * (fanFrond ? 0.64 : 1)
        : cluster.organModel === 'terminal-rosette'
          ? cluster.depth * 0.62
          : size * random.range(0.92, 1.3)
      appendMatrix(
        matrices,
        right,
        up,
        normal,
        position,
        scaleX,
        scaleY,
        cluster.organModel === 'frond'
          ? fanFrond ? size * 1.65 : cluster.depth
          : size,
      )
      appendCardColour(colors, parameters, architecture, cluster, position, index)
      const geometryNoise = hashUnit(cluster.seed, index, position.y, parameters.seed)
      if (cluster.organModel === 'frond') {
        const development = cluster.development ?? 1
        const senescence = clamp(cluster.senescence ?? 0, 0, 1)
        variants.push(
          development < 0.85
            ? Math.min(1, Math.floor(development * 2.5))
            // Variants 6–7 have clustered pinna loss and substantially more
            // rachis droop. Reserve them for the retained lower skirt instead
            // of scattering dead-leaf topology through the live crown.
            : senescence > 0.52
              ? 13 + Math.floor(geometryNoise * 3) % 3
              : senescence > 0.16
                ? 8 + Math.floor(geometryNoise * 5) % 5
                : 2 + Math.floor(geometryNoise * 8) % 8,
        )
      } else {
        variants.push(2 + Math.floor(geometryNoise * 6) % 6)
      }
    }
  }
  return {
    representation: 'cards',
    cardGeometry: graph.foliageClusters.some((cluster) => cluster.organModel === 'frond')
      ? frondGeometry
      : graph.foliageClusters.some((cluster) => cluster.organModel === 'terminal-rosette')
        ? 'rosette'
        : 'spray',
    matrices: Float32Array.from(matrices),
    colors: Float32Array.from(colors),
    variants: Uint8Array.from(variants),
    variantCount: graph.foliageClusters.some((cluster) => cluster.organModel === 'frond')
      ? FROND_GEOMETRY_VARIANTS
      : LEAF_CARD_VARIANTS,
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
  const senescence = clamp(cluster.senescence ?? 0, 0, 1)
  if (cluster.organModel === 'frond' && senescence > 0) {
    // Retained lower palm leaves pass through dusty olive into straw-brown.
    // This is per organ, so the live spear remains green instead of tinting the
    // entire instanced batch as one material.
    const dryValue = value * lerpNumber(0.82, 0.54, senescence)
    target.push(
      dryValue * lerpNumber(1, 1.75, senescence),
      dryValue * lerpNumber(1, 0.62, senescence),
      dryValue * lerpNumber(1, 0.34, senescence),
    )
    return
  }
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

function emptyFoliage(_level: TreeLodLevel): TreeFoliageData {
  return {
    representation: 'cards',
    cardGeometry: 'spray',
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
