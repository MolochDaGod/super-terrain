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
  // Lower LODs draw fewer, larger sprays — carrying the same leaf area.
  //
  // Card count is what dominates a forest, so it has to fall with distance.
  // Leaf *area* is a different quantity, and it is the one the viewer sees:
  // it is what occludes the sky, what the shadow map integrates into floor
  // dapple, and what the eye reads as canopy density. Cutting count without
  // holding area constant is what makes a stand breathe as the camera moves.
  //
  // The rule this replaces compensated only for the cards-per-station cut and
  // ignored the station stride, which was the larger of the two, then clamped
  // what remained at 1.55/1.9. Measured area retained: 25–34% at the middle
  // level and 5–8% at the far one. Walking in ran every crown from a wire
  // sketch through sparse to full, and moved the floor shadows each time.
  //
  // Stations are now grouped spatially down to a card budget, and each merged
  // station is given exactly the area of the stations it stands for. Count
  // falls by the budget; area does not move.
  const stations = lodStations(graph.foliageClusters, architecture, level)
  const frondGeometry = parameters.species === 'doum-palm' ? 'fan-frond' : 'frond'

  for (const cluster of stations) {
    const random = new TreeRandom(cluster.seed + level * 7919)
    // Outward from the crown's own centre, not from the world axis: on a
    // lopsided veteran the two are metres apart and the axis version lights the
    // overhanging side as if it faced inward.
    const outward = normalize(subtract(cluster.center, crownCenter), vec3(0, 1, 0))
    for (let index = 0; index < cluster.cards; index += 1) {
      const jitter = cluster.organModel === 'frond' || cluster.organModel === 'terminal-rosette'
        ? vec3()
        // Spread, not radius. A merged station's cards have to scatter across
        // the volume the merged members occupied, or the crown collapses onto
        // a lattice of centres of mass with holes between them.
        : vec3(
            random.signed() * cluster.spread,
            random.signed() * cluster.spread * 0.81,
            random.signed() * cluster.spread,
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
      const size = cluster.radius * random.range(0.82, 1.24)
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

/**
 * A station as one LOD level sees it: a cluster, or the merger of several.
 */
interface LodStation extends FoliageCluster {
  /** Metres the station's cards scatter around `center`. */
  spread: number
  /** Cards this station emits. */
  cards: number
}

/**
 * Card budget per level, as a fraction of what level 0 emits, with a ceiling
 * so a redwood's five thousand stations do not set the far cost of a stand.
 *
 * These two numbers are the whole distance/quality trade. Because area is now
 * conserved, they buy exactly one thing — card count — and pay for it in card
 * *size*: the merged spray at level 1 is 1/sqrt(0.4) ≈ 1.6 times the width of
 * a near one, and at level 2 about 3.2 times. Push the fractions down and the
 * far crowns get cheaper and blobbier; the density does not change either way.
 */
const LOD_CARD_BUDGET: readonly { fraction: number; ceiling: number }[] = [
  { fraction: 1, ceiling: Number.POSITIVE_INFINITY },
  { fraction: 0.4, ceiling: 1_600 },
  { fraction: 0.1, ceiling: 460 },
]

/**
 * A merged card may not exceed this multiple of the largest spray it stands
 * for. It is a backstop against a nearly empty crown whose few stations are
 * asked to carry the whole budget, not a normal path.
 *
 * The growth needed is sqrt(cardsPerStation / cards * members), so a crown
 * that carries many stations *and* several cards on each — a spruce, at four
 * — reaches past four at the far level once the absolute ceiling binds. Set
 * below that, the cap stops being a backstop and starts silently discarding
 * leaf area, which is the failure this whole file exists to prevent; the
 * regression test that covers area retention catches it either way.
 */
const MAX_MERGED_GROWTH = 5.6

/** Groups the crown's stations down to the level's card budget. */
function lodStations(
  clusters: readonly FoliageCluster[],
  architecture: SpeciesArchitecture,
  level: TreeLodLevel,
): LodStation[] {
  const cardsPerStation = Math.max(1, architecture.cardsPerStation)
  if (level === 0) {
    return clusters.map((cluster) => ({
      ...cluster,
      spread: cluster.radius * 0.42,
      cards: solitary(cluster) ? 1 : cardsPerStation,
    }))
  }
  // A frond or a rosette is one authored organ on a crown that has a few dozen
  // of them, not a branchlet spray among thousands. Merging two of them builds
  // a palm the species does not have, and there is nothing to win: these are
  // already the cheapest crowns in the catalogue.
  const fixed: LodStation[] = []
  const mergeable: FoliageCluster[] = []
  for (const cluster of clusters) {
    if (solitary(cluster)) fixed.push({ ...cluster, spread: 0, cards: 1 })
    else mergeable.push(cluster)
  }
  if (mergeable.length === 0) return fixed

  const budget = LOD_CARD_BUDGET[level] ?? LOD_CARD_BUDGET[LOD_CARD_BUDGET.length - 1]!
  const cardTarget = Math.max(
    cardsPerStation,
    Math.min(
      Math.round(mergeable.length * cardsPerStation * budget.fraction),
      budget.ceiling,
    ),
  )
  // Cards per merged station. Fewer, larger sprays read better at distance
  // than the same area cut into the near tree's confetti, but one card per
  // station is as far as that goes: below that the station is the card.
  const cards = level === 1 ? Math.max(1, Math.round(cardsPerStation * 0.5)) : 1
  const groupTarget = Math.max(
    1,
    Math.min(mergeable.length, Math.ceil(cardTarget / cards)),
  )
  for (const group of spatialGroups(mergeable, groupTarget)) {
    fixed.push(mergeStation(group, cardsPerStation, cards))
  }
  return fixed
}

function solitary(cluster: FoliageCluster): boolean {
  return cluster.organModel === 'frond' || cluster.organModel === 'terminal-rosette'
}

/**
 * One station standing in for a spatial group of them.
 *
 * The radius is the whole point. A level-0 card's area goes as the square of
 * its station radius, so a group carrying `cardsPerStation` cards each of
 * radius r_i is reproduced by `cards` cards of radius
 * sqrt((cardsPerStation / cards) * sum(r_i^2)) — exact in expectation, with no
 * tuned compensation constant to drift out of date.
 */
function mergeStation(
  group: readonly FoliageCluster[],
  cardsPerStation: number,
  cards: number,
): LodStation {
  const first = group[0]!
  let weight = 0
  let center = vec3(0, 0, 0)
  let axis = vec3(0, 0, 0)
  let depth = 0
  let occlusion = 0
  let area = 0
  let largest = 0
  for (const member of group) {
    // Weighted by area, so a merged station sits where the leaf is rather than
    // at the arithmetic centre of a large spray and a token one.
    const share = Math.max(1e-9, member.radius * member.radius)
    weight += share
    area += share
    largest = Math.max(largest, member.radius)
    center = add(center, multiply(member.center, share))
    axis = add(axis, multiply(member.axis, share))
    depth += member.depth * share
    occlusion += member.occlusion * share
  }
  center = multiply(center, 1 / weight)
  let dispersion = 0
  for (const member of group) {
    const offset = subtract(member.center, center)
    dispersion += dot(offset, offset)
  }
  dispersion = Math.sqrt(dispersion / group.length)
  const radius = Math.min(
    Math.sqrt((cardsPerStation / cards) * area),
    largest * MAX_MERGED_GROWTH,
  )
  return {
    ...first,
    center,
    axis: normalize(axis, first.axis),
    radius,
    depth: (depth / weight) * (radius / Math.max(1e-6, first.radius)),
    occlusion: clamp(occlusion / weight, 0, 1),
    spread: Math.max(radius * 0.42, dispersion),
    cards,
  }
}

/**
 * Buckets stations into a uniform grid sized so the occupied cells land near
 * `target`.
 *
 * Grouping by neighbourhood rather than by index is what makes the merge
 * honest. Striding the cluster list took every Nth station in *traversal*
 * order, which is branch order — so the survivors were a comb through the
 * crown's topology, and whichever limbs happened to fall between the teeth
 * lost their foliage outright.
 */
function spatialGroups(
  clusters: readonly FoliageCluster[],
  target: number,
): FoliageCluster[][] {
  if (clusters.length <= target) return clusters.map((cluster) => [cluster])
  let minimum = clusters[0]!.center
  let maximum = clusters[0]!.center
  for (const cluster of clusters) {
    minimum = vec3(
      Math.min(minimum.x, cluster.center.x),
      Math.min(minimum.y, cluster.center.y),
      Math.min(minimum.z, cluster.center.z),
    )
    maximum = vec3(
      Math.max(maximum.x, cluster.center.x),
      Math.max(maximum.y, cluster.center.y),
      Math.max(maximum.z, cluster.center.z),
    )
  }
  const volume = Math.max(
    1e-6,
    (maximum.x - minimum.x) * (maximum.y - minimum.y) * (maximum.z - minimum.z),
  )
  // A crown fills a shell, not its bounding box, so a cell size taken straight
  // from the volume always yields fewer occupied cells than the budget asked
  // for. A few proportional corrections land within a percent or two, which is
  // ample: this picks a card count, not a silhouette.
  let cell = Math.max(1e-4, Math.cbrt(volume / target))
  let groups = bucketStations(clusters, minimum, cell)
  for (let pass = 0; pass < 5; pass += 1) {
    if (Math.abs(groups.length - target) <= target * 0.04) break
    const corrected = cell * Math.cbrt(groups.length / target)
    if (!Number.isFinite(corrected) || corrected <= 0) break
    cell = corrected
    groups = bucketStations(clusters, minimum, cell)
  }
  return groups
}

function bucketStations(
  clusters: readonly FoliageCluster[],
  origin: TreeVec3,
  cell: number,
): FoliageCluster[][] {
  // Insertion-ordered, so the grouping — and therefore every card matrix that
  // follows from it — is a deterministic function of the graph.
  const buckets = new Map<string, FoliageCluster[]>()
  for (const cluster of clusters) {
    const key = `${Math.floor((cluster.center.x - origin.x) / cell)}|` +
      `${Math.floor((cluster.center.y - origin.y) / cell)}|` +
      `${Math.floor((cluster.center.z - origin.z) / cell)}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(cluster)
    else buckets.set(key, [cluster])
  }
  return [...buckets.values()]
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
