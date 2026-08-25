import {
  add,
  clamp,
  cross,
  dot,
  multiply,
  normalize,
  subtract,
  TreeRandom,
  vec3,
} from '../math'
import type { TreeVec3 } from '../types'
import type { GrowthAxisDraft, GrowthAxisSample, OrganStationDraft } from './types'

/**
 * The shared process behind every truly dichotomous tree.
 *
 * A dichotomy is not a branch: the apical meristem itself divides, and the two
 * daughters are equal claimants to the axis that made them. Everything that
 * distinguishes a dragon's blood umbrella from a quiver candelabrum, a Joshua
 * tree from a doum palm, is *when* that division is triggered and what the
 * apex does with the frame it carries — not how many degrees the fork opens.
 *
 * So the process here owns only the mechanism: an apex grows internodes, an
 * event decides whether it continues, divides or dies, and the surviving apices
 * carry a crown. Each species supplies a policy for those decisions. Writing
 * one recursive fork with a table of angles per species produced four versions
 * of the same binary tree, which is exactly what render review rejected.
 */

/** What happens to an apex at the end of an internode. */
export type ApexOutcome =
  | { kind: 'continue' }
  | { kind: 'divide'; ways: number }
  | { kind: 'crown' }
  | { kind: 'abort' }

export interface Apex {
  id: string
  parentId: string
  attachment: number
  position: TreeVec3
  direction: TreeVec3
  /**
   * Unit vector perpendicular to `direction` that the apex divides across.
   *
   * Carrying the plane in the apex rather than choosing it randomly at each
   * fork is what gives a real dichotomous crown its structure: successive
   * planes rotate against each other, which is why the branch tips fill space
   * instead of piling into one fan.
   */
  splitPlane: TreeVec3
  radius: number
  /**
   * Radius of the parent ring inherited at a true continuation junction.
   * `radius` remains the daughter's growth target; conflating the two made the
   * first emitted child ring drop a full daughter ratio in one short band.
   */
  junctionRadius?: number
  /** Forks upstream of this apex. */
  generation: number
  /** Internodes grown since the last fork. */
  internode: number
  vigor: number
  /** True once the apex has lost its meristem — a Yucca's trigger to branch. */
  damaged: boolean
  continuation: boolean
  branchOrder: number
}

export interface InternodeStep {
  length: number
  endRadius: number
  /** Change of bearing over this internode, in radians. */
  crook: number
  /** Vertical component added over this internode, as a fraction of length. */
  rise: number
  /** How many samples this internode contributes. */
  samples: number
}

export interface Daughter {
  direction: TreeVec3
  splitPlane: TreeVec3
  radius: number
  vigor: number
  continuation: boolean
}

export interface DichotomyPolicy {
  /** Hard ceiling so a runaway policy cannot generate forever. */
  generationLimit: number
  /** Girth of the apex that leaves the trunk, relative to the trunk tip. */
  initialRadius: (trunkRadius: number, random: TreeRandom) => number
  internodeStep: (apex: Apex, random: TreeRandom) => InternodeStep
  outcome: (apex: Apex, random: TreeRandom) => ApexOutcome
  divide: (apex: Apex, ways: number, random: TreeRandom) => Daughter[]
  /** Girth multiplier laid down around a division, and how far it reaches. */
  nodeSwell: (apex: Apex) => { amount: number; reach: number }
  /** Cross-section flattening across the split plane, 0 for round wood. */
  nodeFlatten: (apex: Apex) => number
  crown: (
    apex: Apex,
    axis: GrowthAxisDraft,
    random: TreeRandom,
    emit: (organ: OrganStationDraft) => void,
  ) => void
  /**
   * How strongly a daughter is deflected out of crowded airspace, 0 to 1.
   *
   * Transporting the split plane is enough to keep successive forks off one
   * axis, but it says nothing about where the rest of the crown already is. A
   * policy that only rotates its own frame still piles most of its tips into
   * whichever quadrant the first fork happened to favour, which is what plan
   * review caught. Competition for light is the missing term.
   */
  spaceFilling: number
  /** Optional retained dead material along a living axis. */
  skirt?: (
    apex: Apex,
    axis: GrowthAxisDraft,
    random: TreeRandom,
    emit: (organ: OrganStationDraft) => void,
  ) => void
}

/** A unit vector perpendicular to `direction`, as close to `hint` as possible. */
export function perpendicular(direction: TreeVec3, hint: TreeVec3): TreeVec3 {
  const projected = subtract(hint, multiply(direction, dot(hint, direction)))
  if (dot(projected, projected) > 1e-8) return normalize(projected)
  const reference = Math.abs(direction.y) < 0.86 ? vec3(0, 1, 0) : vec3(1, 0, 0)
  return normalize(cross(direction, reference), vec3(1, 0, 0))
}

/**
 * Blends a bearing toward the horizontal.
 *
 * A shoot with no headroom left does not keep climbing; it spends its growth
 * outward instead. Expressing that as an operation on the apex's bearing is
 * what turns a chain of forks into a plate or a candelabrum, rather than a
 * column that overshoots the height the tree was authored to reach.
 */
export function levelled(
  direction: TreeVec3,
  fallback: TreeVec3,
  amount: number,
): TreeVec3 {
  const level = clamp(amount, 0, 1)
  if (level <= 1e-4) return direction
  const horizontal = normalize(vec3(direction.x, 0, direction.z), fallback)
  return normalize(add(
    multiply(direction, 1 - level),
    multiply(horizontal, level),
  ), direction)
}

/**
 * Turns a daughter's bearing outward along *its own* heading.
 *
 * The earlier version pushed every daughter toward the radial measured at the
 * parent apex. Both daughters of a fork therefore received the same outward
 * vector, and at the first fork — where the apex is still on the tree's axis
 * and that vector is an arbitrary fallback — the entire crown was pushed into
 * one azimuth. Overhead review showed the result exactly: a sparse Y with three
 * quarters of the authored crown disk empty.
 *
 * Foraging along the daughter's own horizontal bearing makes the two arms
 * diverge, which is both what a shoot actually does and what fills the plan.
 */
export function forage(
  raw: TreeVec3,
  fallback: TreeVec3,
  level: number,
  push: number,
): TreeVec3 {
  const horizontal = normalize(vec3(raw.x, 0, raw.z), fallback)
  return normalize(add(
    levelled(raw, horizontal, level),
    multiply(horizontal, Math.max(0, push)),
  ), raw)
}

/**
 * A coarse record of where a crown has already put its tips.
 *
 * Sectors in plan, banded by radius, so an apex can be asked whether the
 * airspace it is heading for is taken. Cheap, deterministic, and enough to
 * turn a crown that collapses into one quadrant into one that fills its disc.
 */
export class CrownOccupancy {
  private readonly bins: Float32Array
  private readonly sectors: number
  private readonly centreX: number
  private readonly centreZ: number
  private readonly reach: number

  constructor(centreX: number, centreZ: number, reach: number, sectors = 16) {
    this.centreX = centreX
    this.centreZ = centreZ
    this.reach = reach
    this.sectors = sectors
    this.bins = new Float32Array(sectors)
  }

  private sectorOf(x: number, z: number): number {
    const angle = Math.atan2(z - this.centreZ, x - this.centreX)
    const turnFraction = (angle + Math.PI) / (Math.PI * 2)
    return Math.min(
      this.sectors - 1,
      Math.max(0, Math.floor(turnFraction * this.sectors)),
    )
  }

  /** Records a tip, weighted by how far out it reached. */
  add(position: TreeVec3): void {
    const radial = Math.hypot(position.x - this.centreX, position.z - this.centreZ)
    this.bins[this.sectorOf(position.x, position.z)]! +=
      clamp(radial / Math.max(1e-3, this.reach), 0.15, 1)
  }

  /**
   * Rotates a bearing toward the emptiest nearby airspace.
   *
   * Bounded on purpose: this is a shoot leaning toward the light, not a
   * scattering operator, and letting it turn further destroys the architecture
   * the policy just described.
   */
  deflect(from: TreeVec3, bearing: TreeVec3, strength: number): TreeVec3 {
    if (strength <= 1e-3) return bearing
    const horizontal = normalize(vec3(bearing.x, 0, bearing.z), vec3(1, 0, 0))
    const centre = this.sectorOf(
      from.x + horizontal.x * this.reach * 0.4,
      from.z + horizontal.z * this.reach * 0.4,
    )
    // Three bins in a sixteen-bin crown is still a local phototropic response,
    // but it is wide enough for a late-generation apex to escape the pair of
    // sectors already claimed by its parent and sibling. A strict quarter-turn
    // window left a third of Dragon's authored plate empty after subordinate
    // forks were correctly back-set into their nodes.
    const span = Math.max(1, Math.round(this.sectors / 6))
    let bestOffset = 0
    let bestLoad = Infinity
    for (let offset = -span; offset <= span; offset += 1) {
      const index = (centre + offset + this.sectors * 2) % this.sectors
      // A small preference for keeping the authored bearing, so an equally
      // empty sector never wins over the one the policy chose.
      const load = this.bins[index]! + Math.abs(offset) * 0.12
      if (load < bestLoad) {
        bestLoad = load
        bestOffset = offset
      }
    }
    if (bestOffset === 0) return bearing
    const angle = (bestOffset / this.sectors) * Math.PI * 2 * clamp(strength, 0, 1)
    return normalize(turn(bearing, vec3(0, 1, 0), angle), bearing)
  }
}

/** Rotates `value` about a unit `axis`. */
export function turn(value: TreeVec3, axis: TreeVec3, angle: number): TreeVec3 {
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return add(
    add(multiply(value, cosine), multiply(cross(axis, value), sine)),
    multiply(axis, dot(axis, value) * (1 - cosine)),
  )
}

/**
 * Runs the apical process from one starting apex.
 *
 * The whole run between two divisions becomes a single axis, so the wood
 * between forks is one continuous sweep and only a genuine division creates a
 * new member. That is the difference the mesher cares about: a continuation
 * carries the parent's ring through, and a true fork does not.
 */
export function growApicalDichotomy(
  start: Apex,
  policy: DichotomyPolicy,
  random: TreeRandom,
  reach: number,
  budget = 400,
): { axes: GrowthAxisDraft[]; organs: OrganStationDraft[] } {
  const axes: GrowthAxisDraft[] = []
  const organs: OrganStationDraft[] = []
  const emit = (organ: OrganStationDraft) => organs.push(organ)
  const occupancy = new CrownOccupancy(
    start.position.x,
    start.position.z,
    Math.max(0.5, reach),
  )
  const pending: Apex[] = [start]

  while (pending.length > 0 && axes.length < budget) {
    const apex = pending.shift()!
    const embeddedAxis = !apex.continuation && apex.generation > 0
    const samples: GrowthAxisSample[] = [{
      position: apex.position,
      // This station is inside the parent node. Beginning it at full daughter
      // girth makes the closed subordinate shell emerge as a hard cone even
      // when its cap is hidden. Cambial initiation is narrower inside the
      // union and reaches the authored girth across the first internode.
      radius: embeddedAxis
        ? apex.radius * 0.42
        : apex.junctionRadius ?? apex.radius,
    }]
    let outcome: ApexOutcome = { kind: 'crown' }

    // Grow internodes until something happens to the meristem.
    for (let step = 0; step < 12; step += 1) {
      const plan = policy.internodeStep(apex, random)
      appendInternode(samples, apex, plan, random)
      apex.internode += 1
      outcome = apex.generation >= policy.generationLimit
        ? { kind: 'crown' }
        : policy.outcome(apex, random)
      if (outcome.kind !== 'continue') break
    }

    const axis: GrowthAxisDraft = {
      id: apex.id,
      parentId: apex.parentId,
      attachment: apex.attachment,
      branchOrder: apex.branchOrder,
      continuation: apex.continuation,
      // Both daughters of a division are as thick as the axis that made them,
      // so neither can take a projected collar. The subordinate one opens
      // inside the node and the shared junction blend fuses the surfaces.
      embedded: embeddedAxis,
      samples,
    }
    axes.push(axis)
    // Every axis end claims airspace, not only the ones that carry a crown.
    // Recording it at the crown alone left the occupancy empty for the whole
    // breadth-first wave of divisions — the mechanism was inert exactly when it
    // was needed.
    occupancy.add(samples.at(-1)!.position)

    if (outcome.kind === 'abort') continue

    if (outcome.kind === 'divide') {
      const swell = policy.nodeSwell(apex)
      const flatten = policy.nodeFlatten(apex)
      applyNodeSwell(samples, swell.amount, swell.reach, flatten, apex.splitPlane)
      const daughters = policy.divide(apex, outcome.ways, random)
      const origin = samples.at(-1)!.position
      for (const [index, daughter] of daughters.entries()) {
        // Competition for airspace, applied after the policy has described the
        // fork rather than instead of it.
        const direction = occupancy.deflect(
          origin,
          daughter.direction,
          policy.spaceFilling,
        )
        // A subordinate daughter is not a closed tube glued to the end of the
        // parent. Its cambium begins inside the swollen fork and only becomes
        // visible after crossing the parent's surface. Starting every daughter
        // at `origin` left the first full-radius ring and its start cap on the
        // exterior; recursive forks then rendered as stacked knuckles even
        // though the part was labelled `embedded`.
        //
        // Back-setting along the parent's terminal tangent makes that semantic
        // role true geometrically. The continuation still owns the terminal
        // ring while the subordinate daughter grows out through the shared
        // node.
        const embedded = !daughter.continuation
        const insertionDepth = embedded
          // The cap only needs to sit inside the parent's cross-section. A
          // parent-radius back-set made a subordinate trunk-scale daughter run
          // through the bole for nearly a metre, so several hidden full-girth
          // tubes accumulated into the spherical blobs seen at D7's primary
          // junction.
          ? daughter.radius * 0.9
          : 0
        const childOrigin = insertionDepth > 0
          ? subtract(origin, multiply(apex.direction, insertionDepth))
          : origin
        const child: Apex = {
          id: `${apex.id}-${index + 1}`,
          parentId: apex.id,
          attachment: 1,
          position: childOrigin,
          direction,
          splitPlane: perpendicular(direction, daughter.splitPlane),
          radius: daughter.radius,
          junctionRadius: daughter.continuation ? apex.radius : undefined,
          generation: apex.generation + 1,
          internode: 0,
          vigor: daughter.vigor,
          damaged: false,
          continuation: daughter.continuation,
          branchOrder: apex.branchOrder + 1,
        }
        // The daughter's own first station inherits the node, so the swollen
        // shoulder is one continuous piece of wood across the division rather
        // than a collar stamped on the parent.
        pending.push(child)
      }
      continue
    }

    policy.crown(apex, axis, random, emit)
    policy.skirt?.(apex, axis, random, emit)
  }

  return { axes, organs }
}

function appendInternode(
  samples: GrowthAxisSample[],
  apex: Apex,
  plan: InternodeStep,
  random: TreeRandom,
): void {
  const count = Math.max(4, plan.samples)
  // For an embedded daughter the first semantic station is deliberately
  // narrower than the apex's eventual girth. Read the actual station so the
  // first internode grows out continuously instead of jumping to full size at
  // its first emitted ring.
  const startRadius = samples.at(-1)!.radius
  const side = perpendicular(apex.direction, vec3(
    random.signed(),
    random.signed() * 0.3,
    random.signed(),
  ))
  // The bearing changes over the internode rather than at its ends, so the
  // wood curves instead of being a polyline of straight tubes with kinks.
  const endDirection = normalize(add(
    turn(apex.direction, cross(apex.direction, side), plan.crook),
    vec3(0, plan.rise, 0),
  ))
  let position = apex.position
  for (let index = 1; index <= count; index += 1) {
    const t = index / count
    const bearing = normalize(add(
      multiply(apex.direction, 1 - t),
      multiply(endDirection, t),
    ))
    position = add(position, multiply(bearing, plan.length / count))
    samples.push({
      position,
      radius: startRadius + (plan.endRadius - startRadius) * t,
    })
  }
  apex.position = position
  apex.direction = endDirection
  apex.radius = plan.endRadius
}

/**
 * Lays reaction wood around a division.
 *
 * A dichotomy leaves a swollen, flattened node — the two daughters press
 * against each other as they thicken, so the wood is widest across the split
 * plane and narrowest along it. Expressing that on the samples means the fork
 * is part of the same swept surface instead of a separately meshed collar.
 */
function applyNodeSwell(
  samples: GrowthAxisSample[],
  amount: number,
  reach: number,
  flatten: number,
  splitPlane: TreeVec3,
): void {
  if (amount <= 1 && flatten <= 0) return
  const last = samples.length - 1
  let distance = 0
  for (let index = last; index > 0; index -= 1) {
    const step = Math.hypot(
      samples[index]!.position.x - samples[index - 1]!.position.x,
      samples[index]!.position.y - samples[index - 1]!.position.y,
      samples[index]!.position.z - samples[index - 1]!.position.z,
    )
    const nearness = clamp(1 - distance / Math.max(1e-4, reach), 0, 1)
    const eased = nearness * nearness * (3 - 2 * nearness)
    samples[index]!.swell = 1 + (amount - 1) * eased
    samples[index]!.flatten = flatten * eased
    samples[index]!.flattenAxis = splitPlane
    distance += step
    if (distance > reach) break
  }
}
