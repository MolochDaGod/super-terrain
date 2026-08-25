import {
  add,
  clamp,
  cross,
  lengthSquared,
  multiply,
  normalize,
  smoothstep,
  subtract,
  TreeRandom,
  vec3,
} from './math'
import type { TreeVec3 } from './types'

/**
 * Crown growth by space colonisation (Runions et al.).
 *
 * The previous architecture enumerated scaffolds by hand: N primaries, M
 * secondaries each, a fixed twig count under those. That produces one tree —
 * re-seeding only jitters angles, so every result has the same fan silhouette
 * and the same three foliage lobes, and the ramification stops two tiers short
 * of a real crown.
 *
 * Colonisation inverts the authoring. The species description is a *crown
 * envelope*; growth fills it competitively from a handful of scaffold seeds.
 * Ramification density, tip distribution, the lobed outer boundary and the
 * asymmetry all fall out of the attractor cloud instead of being enumerated,
 * so a new seed is a genuinely different tree of the same species.
 */

export interface GrowthNode {
  parent: number
  /** Index of the seed this node descends from. */
  seed: number
  position: TreeVec3
  /** Unit heading of the segment that arrived here. */
  direction: TreeVec3
  children: number[]
  /** Ramification order: 0 along a seed's own axis, +1 across every fork. */
  order: number
  radius: number
  /** Longest path from here to a tip, in metres. Picks the continuation child. */
  subtreeLength: number
  /** Every metre of wood carried above this node, branches included. */
  subtreeTotal: number
  tipCount: number
  /** 0 at the crown surface, 1 deep in the shaded interior. */
  occlusion: number
}

export interface GrowthSeed {
  position: TreeVec3
  direction: TreeVec3
  /** Parameter along the bole this scaffold leaves from. */
  attachment: number
  /** Radius the bole can hand this scaffold at that station. */
  availableRadius: number
}

/**
 * One crown unit: a single mass of foliage with its own centre and extent.
 *
 * A crown is not one blob. A veteran oak is a *colony* of crowns — the original
 * one, plus a mass over each surviving scaffold, plus a small new one over
 * every reiteration that answered a lost limb. That is why an old oak reads as
 * several trees fused together and a young one reads as a single dome, and it
 * is why re-seeding a single-envelope generator produces the same lollipop
 * every time however hard its noise is driven.
 */
export interface CrownLobe {
  centreX: number
  centreZ: number
  /** Where the mass sits and how far it extends vertically. */
  baseY: number
  topY: number
  radius: number
  /** Height of the widest band within the lobe, 0 at its base and 1 at its top. */
  broadness: number
  /** Low values square the profile off; high values round it toward a cone. */
  profileExponent: number
  lobeAmplitude: number
  ripples: number
  /** Set from the lobe's seed so no two share a boundary. */
  phases: readonly number[]
}

export interface CrownEnvelope {
  lobes: readonly CrownLobe[]
  baseY: number
  topY: number
  /** Whether a point is inside the union, with an optional slack factor. */
  contains(point: TreeVec3, margin?: number): boolean
  /** How deep inside the union a point sits, 0 at the surface and 1 at the core. */
  depthAt(point: TreeVec3): number
  /** Horizontal reach at a height, across the whole union. Used for framing. */
  spread(): number
}

export function buildCrownEnvelope(lobes: readonly CrownLobe[]): CrownEnvelope {
  const usable = lobes.filter((lobe) => lobe.radius > 1e-3 && lobe.topY > lobe.baseY)
  const baseY = usable.reduce((lowest, lobe) => Math.min(lowest, lobe.baseY), Infinity)
  const topY = usable.reduce((highest, lobe) => Math.max(highest, lobe.topY), -Infinity)
  return {
    lobes: usable,
    baseY: Number.isFinite(baseY) ? baseY : 0,
    topY: Number.isFinite(topY) ? topY : 1,
    contains(point, margin = 1) {
      for (const lobe of usable) {
        if (lobeFill(lobe, point) <= margin) return true
      }
      return false
    },
    depthAt(point) {
      let deepest = 0
      for (const lobe of usable) {
        deepest = Math.max(deepest, clamp(1 - lobeFill(lobe, point), 0, 1))
      }
      return deepest
    },
    spread() {
      let reach = 0
      for (const lobe of usable) {
        reach = Math.max(
          reach,
          Math.hypot(lobe.centreX, lobe.centreZ) + lobe.radius * 1.3,
        )
      }
      return reach
    },
  }
}

/**
 * Normalised radial position of a point within one lobe: below 1 is inside,
 * above 1 is outside, and the value at the surface is exactly 1.
 */
function lobeFill(lobe: CrownLobe, point: TreeVec3): number {
  const span = Math.max(1e-3, lobe.topY - lobe.baseY)
  const u = (point.y - lobe.baseY) / span
  if (u < 0 || u > 1) return Infinity
  const offsetX = point.x - lobe.centreX
  const offsetZ = point.z - lobe.centreZ
  const azimuth = Math.atan2(offsetZ, offsetX)
  const limit = lobeRadiusAt(lobe, u) * lobeRippleAt(lobe, azimuth, u)
  if (limit <= 1e-4) return Infinity
  return Math.hypot(offsetX, offsetZ) / limit
}

function lobeRadiusAt(lobe: CrownLobe, u: number): number {
  const centred = clamp(u, 0, 1)
  // The crown does not stop at a plane. Below the widest band the boundary
  // keeps some width all the way down, or the underside is cut off square and
  // the tree reads as a mushroom cap on a stick.
  const skirt = lobe.broadness * 0.42
  if (centred < skirt) {
    const skirtWidth = skirt / Math.max(1e-4, lobe.broadness)
    return lobe.radius * Math.pow(skirtWidth, lobe.profileExponent) *
      (0.35 + 0.65 * Math.pow(centred / Math.max(1e-4, skirt), 0.55))
  }
  // Distance from the widest band out to whichever end is nearer, so the
  // profile is a squashed superellipse rather than a sphere. A small exponent
  // is what gives an oak its blocky, flat-topped mass.
  const toEdge = centred < lobe.broadness
    ? centred / Math.max(1e-4, lobe.broadness)
    : (1 - centred) / Math.max(1e-4, 1 - lobe.broadness)
  return lobe.radius * Math.pow(clamp(toEdge, 0, 1), lobe.profileExponent)
}

function lobeRippleAt(lobe: CrownLobe, azimuth: number, u: number): number {
  // Two incommensurate angular harmonics plus a height term: the boundary never
  // repeats around the axis and never reads as a lathe profile.
  const count = Math.max(2, lobe.ripples)
  const primary = Math.sin(azimuth * count + lobe.phases[0]! + u * 1.7)
  const secondary = Math.sin(azimuth * (count + 3) + lobe.phases[1]! - u * 2.3)
  const vertical = Math.sin(u * Math.PI * 2.6 + lobe.phases[2]!)
  return 1 + lobe.lobeAmplitude *
    (primary * 0.6 + secondary * 0.26 + vertical * 0.14)
}

/** Deterministic boundary phases for a lobe, so its shape follows its seed. */
export function lobePhases(seed: number): number[] {
  const random = new TreeRandom((seed ^ 0x9e3779b9) >>> 0 || 1)
  return [0, 1, 2, 3].map(() => random.range(0, Math.PI * 2))
}

export interface GrowthSettings {
  segmentLength: number
  /** Attractors farther than this cannot influence a node. */
  influenceRadius: number
  /** Attractors are consumed once a node comes this close. */
  killRadius: number
  attractorCount: number
  /** Pull toward the light, strongest on low limbs. */
  upTropism: number
  /** Self-weight droop, applied to whatever the attractors ask for. */
  sag: number
  /** How much of the previous heading survives each step. */
  axialPersistence: number
  /** Random walk applied per step, in radians. */
  wander: number
  maximumIterations: number
  /** Shell bias of the attractor cloud: higher hollows out the interior. */
  shellBias: number
  /** Radius below which wood is no longer worth sweeping as geometry. */
  tipRadius: number
}

/**
 * Grows a node tree that fills the envelope from the given scaffold seeds.
 *
 * Nodes are inserted into a uniform grid as they are created; without it the
 * nearest-node query is quadratic in the attractor cloud and a hero crown takes
 * minutes rather than a second.
 */
export function growCrown(
  seeds: readonly GrowthSeed[],
  envelope: CrownEnvelope,
  settings: GrowthSettings,
  random: TreeRandom,
): GrowthNode[] {
  const attractors = sampleAttractors(envelope, settings, random)
  const nodes: GrowthNode[] = []
  const grid = new NodeGrid(settings.influenceRadius)

  for (const [index, seed] of seeds.entries()) {
    nodes.push({
      parent: -1,
      seed: index,
      position: { ...seed.position },
      direction: normalize(seed.direction),
      children: [],
      order: 0,
      radius: 0,
      subtreeLength: 0,
      subtreeTotal: 0,
      tipCount: 0,
      occlusion: 0,
    })
    grid.insert(seed.position, nodes.length - 1)
  }

  const alive = new Uint8Array(attractors.length).fill(1)
  const pull = new Map<number, TreeVec3>()
  const killRadiusSquared = settings.killRadius ** 2
  const influenceSquared = settings.influenceRadius ** 2

  for (let iteration = 0; iteration < settings.maximumIterations; iteration += 1) {
    pull.clear()
    let remaining = 0
    for (let index = 0; index < attractors.length; index += 1) {
      if (!alive[index]) continue
      remaining += 1
      const attractor = attractors[index]!
      const nearest = grid.nearest(attractor, nodes, influenceSquared)
      if (nearest < 0) continue
      const offset = subtract(attractor, nodes[nearest]!.position)
      if (lengthSquared(offset) <= killRadiusSquared) {
        alive[index] = 0
        remaining -= 1
        continue
      }
      const existing = pull.get(nearest)
      const contribution = normalize(offset)
      pull.set(
        nearest,
        existing ? add(existing, contribution) : contribution,
      )
    }
    if (remaining === 0 || pull.size === 0) break

    for (const [nodeIndex, accumulated] of pull) {
      const parent = nodes[nodeIndex]!
      const attractorHeading = normalize(accumulated, parent.direction)
      const crownHeight = clamp(
        (parent.position.y - envelope.baseY) /
          Math.max(1e-3, envelope.topY - envelope.baseY),
        0,
        1,
      )
      // Light-seeking is strongest on the limbs that are most overshadowed,
      // which is what turns a heavy horizontal oak limb up at its end instead
      // of letting it run straight out to the envelope wall.
      const rise = settings.upTropism * (1 - crownHeight * 0.55)
      const horizontal = Math.hypot(attractorHeading.x, attractorHeading.z)
      const droop = settings.sag * horizontal * horizontal
      const jitter = randomUnitVector(random)
      const heading = normalize(
        add(
          add(
            multiply(parent.direction, settings.axialPersistence),
            attractorHeading,
          ),
          add(
            vec3(0, rise - droop, 0),
            multiply(jitter, settings.wander),
          ),
        ),
        parent.direction,
      )
      const position = add(parent.position, multiply(heading, settings.segmentLength))
      // Attractors sit inside the envelope, but tropism and wander are added on
      // top of where they point, so a tip can overshoot the boundary and keep
      // going. Those overshoots are the bare wires that stick out past the
      // foliage and destroy the silhouette, so a step that leaves the envelope
      // simply does not happen.
      // Below the crown base a limb is still on its way out from the bole, so
      // only the union itself is enforced.
      if (position.y > envelope.baseY && !envelope.contains(position, 1.06)) continue
      nodes.push({
        parent: nodeIndex,
        seed: parent.seed,
        position,
        direction: heading,
        children: [],
        order: 0,
        radius: 0,
        subtreeLength: 0,
        subtreeTotal: 0,
        tipCount: 0,
        occlusion: 0,
      })
      const childIndex = nodes.length - 1
      parent.children.push(childIndex)
      grid.insert(position, childIndex)
    }
  }

  measureSubtrees(nodes, settings.segmentLength)
  assignOrders(nodes)
  solvePipeRadii(nodes, seeds, settings.tipRadius, settings.segmentLength)
  measureOcclusion(nodes, envelope)
  return nodes
}

/**
 * Rejection-samples the crown volume. `shellBias` biases acceptance toward the
 * outer shell, so the interior stays open the way a real canopy is: a solid
 * cloud grows a solid ball of twigs and hides every limb behind leaves.
 */
function sampleAttractors(
  envelope: CrownEnvelope,
  settings: GrowthSettings,
  random: TreeRandom,
): TreeVec3[] {
  const points: TreeVec3[] = []
  if (envelope.lobes.length === 0) return points
  const span = envelope.topY - envelope.baseY
  const reach = envelope.spread()
  // Each lobe gets attractors in proportion to its own volume, so a small
  // reiteration crown does not end up as densely twigged as the main mass.
  const weights = envelope.lobes.map((lobe) =>
    lobe.radius * lobe.radius * Math.max(0.1, lobe.topY - lobe.baseY),
  )
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const attempts = settings.attractorCount * 30
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (points.length >= settings.attractorCount) break
    let roll = random.unit() * total
    let chosen = envelope.lobes[0]!
    for (const [index, lobe] of envelope.lobes.entries()) {
      roll -= weights[index]!
      if (roll <= 0) {
        chosen = lobe
        break
      }
    }
    const u = random.unit()
    const azimuth = random.range(0, Math.PI * 2)
    // Square-rooted radius keeps the cloud areally uniform before the shell
    // bias is applied; sampling the radius linearly clumps it at the axis.
    const radial = Math.sqrt(random.unit()) * chosen.radius * 1.3
    const candidate = vec3(
      chosen.centreX + Math.cos(azimuth) * radial,
      chosen.baseY + u * Math.max(1e-3, chosen.topY - chosen.baseY),
      chosen.centreZ + Math.sin(azimuth) * radial,
    )
    const depth = envelope.depthAt(candidate)
    if (depth <= 0) continue
    // Shell bias measured against the union, not the lobe that proposed the
    // point: where two crowns overlap the interior is genuinely interior.
    if (random.unit() > Math.pow(1 - depth, settings.shellBias)) continue
    if (Math.hypot(candidate.x, candidate.z) > reach * 1.2) continue
    if (candidate.y < envelope.baseY || candidate.y > envelope.topY + span * 0.02) {
      continue
    }
    points.push(candidate)
  }
  return points
}

function measureSubtrees(nodes: GrowthNode[], segmentLength: number): void {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!
    if (node.children.length === 0) {
      node.subtreeLength = 0
      node.subtreeTotal = 0
      node.tipCount = 1
      continue
    }
    let longest = 0
    let total = 0
    let tips = 0
    for (const child of node.children) {
      longest = Math.max(longest, nodes[child]!.subtreeLength + segmentLength)
      total += nodes[child]!.subtreeTotal + segmentLength
      tips += nodes[child]!.tipCount
    }
    node.subtreeLength = longest
    node.subtreeTotal = total
    node.tipCount = tips
  }
}

/**
 * The child that carries the longest remaining path is the axis; every other
 * child is a fork. Ordering by that rather than by creation index is what keeps
 * a scaffold limb reading as one continuous member through the crown.
 */
function assignOrders(nodes: GrowthNode[]): void {
  for (const node of nodes) {
    if (node.children.length === 0) continue
    let axis = node.children[0]!
    for (const child of node.children) {
      if (nodes[child]!.subtreeLength > nodes[axis]!.subtreeLength) axis = child
    }
    for (const child of node.children) {
      nodes[child]!.order = child === axis ? node.order : node.order + 1
    }
    // The axis child first, so downstream chain walks find it without a search.
    node.children.sort((a, b) => (a === axis ? -1 : b === axis ? 1 : 0))
  }
}

/**
 * Da Vinci's rule with a slightly super-quadratic exponent, then normalised per
 * scaffold so the crown's own tip count decides how thick its limb has to be
 * and the bole hands out exactly the cross-section it has.
 */
function solvePipeRadii(
  nodes: GrowthNode[],
  seeds: readonly GrowthSeed[],
  tipRadius: number,
  segmentLength: number,
): void {
  // Radius from the total wood carried above a node rather than from its tip
  // count. Counting tips gives an unbranched member a constant radius all the
  // way to its end — the "bent wire" look — because nothing about it changes
  // until it forks. Total carried length keeps taper running continuously along
  // a member and still swells it sharply below a heavy fork, which is what a
  // pipe model is actually for.
  const exponent = 2.4
  for (const node of nodes) {
    node.radius = Math.pow(node.subtreeTotal + segmentLength, 1 / exponent)
  }

  for (const [index, seed] of seeds.entries()) {
    const root = nodes[index]
    if (!root || root.radius <= 0) continue
    // `availableRadius` is already the local radius budget at this seed's
    // attachment. Scaffolds leave at different heights, so dividing it again
    // by every tip in every other scaffold makes a mature load-bearing limb
    // implausibly thin. Siblings that truly share one junction are conserved
    // later by `solveRadiusInheritance`; each independent seed should fill its
    // own local budget here.
    const scale = seed.availableRadius / root.radius
    const stack = [index]
    while (stack.length > 0) {
      const current = stack.pop()!
      const node = nodes[current]!
      node.radius = Math.max(tipRadius, node.radius * scale)
      for (const child of node.children) stack.push(child)
    }
  }
}

/**
 * How buried each node is inside the crown, used later to darken interior
 * foliage. A canopy without an occluded core reads as stickers on glass no
 * matter how good the leaf art is.
 */
function measureOcclusion(nodes: GrowthNode[], envelope: CrownEnvelope): void {
  for (const node of nodes) {
    const u = clamp(
      (node.position.y - envelope.baseY) /
        Math.max(1e-3, envelope.topY - envelope.baseY),
      0,
      1,
    )
    // Depth below the crown's own top matters as much as depth from its side:
    // the underside of an oak is its darkest region.
    const fromSide = envelope.depthAt(node.position)
    const fromTop = smoothstep(1, 0.25, u)
    node.occlusion = clamp(fromSide * 0.72 + fromTop * 0.42, 0, 1)
  }
}

function randomUnitVector(random: TreeRandom): TreeVec3 {
  const z = random.signed()
  const azimuth = random.range(0, Math.PI * 2)
  const ring = Math.sqrt(Math.max(0, 1 - z * z))
  return vec3(Math.cos(azimuth) * ring, z, Math.sin(azimuth) * ring)
}

/** Uniform spatial hash over node positions, sized to the influence radius. */
class NodeGrid {
  private readonly cells = new Map<number, number[]>()
  private readonly cellSize: number

  constructor(cellSize: number) {
    this.cellSize = cellSize
  }

  insert(position: TreeVec3, index: number): void {
    const key = this.key(position)
    const bucket = this.cells.get(key)
    if (bucket) bucket.push(index)
    else this.cells.set(key, [index])
  }

  nearest(
    point: TreeVec3,
    nodes: readonly GrowthNode[],
    maximumDistanceSquared: number,
  ): number {
    const size = this.cellSize
    const baseX = Math.floor(point.x / size)
    const baseY = Math.floor(point.y / size)
    const baseZ = Math.floor(point.z / size)
    let best = -1
    let bestDistance = maximumDistanceSquared
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
          const bucket = this.cells.get(
            hashCell(baseX + offsetX, baseY + offsetY, baseZ + offsetZ),
          )
          if (!bucket) continue
          for (const index of bucket) {
            const distance = lengthSquared(subtract(point, nodes[index]!.position))
            if (distance < bestDistance) {
              bestDistance = distance
              best = index
            }
          }
        }
      }
    }
    return best
  }

  private key(position: TreeVec3): number {
    return hashCell(
      Math.floor(position.x / this.cellSize),
      Math.floor(position.y / this.cellSize),
      Math.floor(position.z / this.cellSize),
    )
  }
}

function hashCell(x: number, y: number, z: number): number {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0
}

/**
 * Walks the node tree into chains: one chain per continuous member, starting at
 * a seed or at a fork, following the axis child to a tip. The mesher sweeps
 * chains, so this is what decides whether a limb reads as one member or as a
 * string of butted stubs.
 */
export interface GrowthChain {
  /** Nodes swept, in order. For a fork this begins at the fork node itself. */
  nodes: number[]
  /**
   * The node this chain actually *owns*: a seed, or the child at a fork.
   *
   * Distinct from `nodes[0]`, which for a fork is the shared node belonging to
   * the parent member. Conflating the two made every chain leaving a seed look
   * like that seed's own axis, so a fork off the trunk apex was indistinguishable
   * from the trunk's continuation — two members claiming the same identity and
   * the same end ring.
   */
  root: number
}

/**
 * Walks the node tree into chains: one chain per continuous member, starting at
 * a seed or at a fork and following the axis child to a tip. The mesher sweeps
 * chains, so this is what decides whether a limb reads as one member or as a
 * string of butted stubs.
 */
export function chainsFrom(
  nodes: readonly GrowthNode[],
  seedCount: number,
): GrowthChain[] {
  const chains: GrowthChain[] = []
  const starts: number[] = []
  for (let index = 0; index < seedCount && index < nodes.length; index += 1) {
    starts.push(index)
  }
  while (starts.length > 0) {
    const start = starts.pop()!
    // A forked chain begins at the *fork*, not at the first node past it.
    // Starting it at the child left a whole segment of empty space between the
    // parent member and the one leaving it — a visible break in the skeleton
    // and, once swept, a limb floating clear of the branch it grows from.
    const parent = nodes[start]!.parent
    const walk = parent >= 0 ? [parent, start] : [start]
    let current = start
    for (;;) {
      const node = nodes[current]!
      if (node.children.length === 0) break
      const axis = node.children[0]!
      for (let index = 1; index < node.children.length; index += 1) {
        starts.push(node.children[index]!)
      }
      walk.push(axis)
      current = axis
    }
    if (walk.length >= 2) chains.push({ nodes: walk, root: start })
  }
  return chains
}

/** Perpendicular basis for a heading, stable enough for gnarl displacement. */
export function perpendicular(direction: TreeVec3): TreeVec3 {
  const reference = Math.abs(direction.y) > 0.92 ? vec3(1, 0, 0) : vec3(0, 1, 0)
  return normalize(cross(direction, reference), vec3(1, 0, 0))
}
