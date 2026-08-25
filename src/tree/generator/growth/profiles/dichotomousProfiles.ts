import { add, clamp, lerpNumber, multiply, normalize, vec3 } from '../../math'
import type { TreeSpecies } from '../../speciesCatalog'
import type { TreeParameters } from '../../types'
import {
  forage,
  perpendicular,
  turn,
  type Apex,
  type DichotomyPolicy,
} from '../apicalDichotomy'
import { sampleAxisPosition } from '../axis'

/**
 * Species adapters for the apical dichotomy process.
 *
 * Each of these is a different *grammar*, not a different set of numbers. A
 * dragon's blood apex divides after every flowering and rotates its split plane
 * a quarter turn, so its crown closes into a plate. A quiver apex divides
 * rarely and unequally, so it builds a chunky candelabrum. A Joshua apex only
 * divides when something kills it, and then throws several shoots at once, so
 * its architecture records damage. A doum apex divides twice in a lifetime and
 * carries a fan crown of several leaf ages at each surviving tip.
 */

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/**
 * The space a crown has to build itself in.
 *
 * Sizing internodes from `crownRadius` alone let every one of these species
 * overshoot its own authored height by half again: the process has no idea how
 * much of the tree the bole already used. Handing the apex its headroom makes
 * the crown a component that fits the tree it belongs to, and it is also what
 * lets a policy decide to stop climbing and spread instead.
 */
export interface CrownSite {
  /** Height of the apex the bole hands over. */
  boleTop: number
  /** Girth there. */
  boleRadius: number
  /** Height the finished tree should reach. */
  ceiling: number
  /** Horizontal reach the crown should fill. */
  reach: number
  /** Plan position of the bole, so outward is measured from the tree's axis. */
  centreX: number
  centreZ: number
}

/** Vertical space left for the crown. */
function headroomOf(site: CrownSite): number {
  return Math.max(1, site.ceiling - site.boleTop)
}

/**
 * How boxed-in an apex is, and which way is out.
 *
 * `crowded` runs from 0 at the top of the bole to 1 at the tree's ceiling;
 * `room` runs from 1 on the crown axis to 0 at its authored reach. Together
 * they are the whole reason these crowns spread instead of climbing: an apex
 * near the ceiling with room to the side turns outward, exactly as it does
 * under real apical control.
 */
function spreadBias(apex: Apex, site: CrownSite): {
  crowded: number
  room: number
} {
  const dx = apex.position.x - site.centreX
  const dz = apex.position.z - site.centreZ
  const radial = Math.hypot(dx, dz)
  return {
    // No levelling at all in the first quarter of the crown — those are the
    // structural tiers and they have to climb — then a steady ramp to fully
    // horizontal at the ceiling. Measuring it linearly from the bole top made
    // the crown turn outward before it had built any height; easing it from
    // the bole top made it turn outward almost immediately.
    crowded: Math.pow(clamp(
      (apex.position.y - site.boleTop - headroomOf(site) * 0.28) /
        (headroomOf(site) * 0.72),
      0,
      1,
    ), 0.8),
    room: clamp(1 - radial / Math.max(1e-3, site.reach), 0, 1),
  }
}

/**
 * How far the split plane advances between generations.
 *
 * A fixed quarter turn has period two: the planes alternate between the same
 * pair of directions and the crown fills four azimuths instead of the circle.
 * Scattering the turn around a right angle keeps the near-orthogonal habit a
 * real dichotomy has while never repeating.
 */
function planeAdvance(random: { range: (a: number, b: number) => number }): number {
  return Math.PI * 0.5 * random.range(0.55, 1.45)
}

function seedFrom(random: { unit: () => number }): number {
  return Math.floor(random.unit() * 0x7fffffff)
}

/**
 * Dracaena cinnabari — the umbrella.
 *
 * Every apex flowers, and every flowering divides it. Nothing aborts, so the
 * count doubles each generation while the internodes shorten geometrically:
 * the tips of the last generations end up crowded into one layer. Rotating the
 * split plane a quarter turn per generation is what fills that layer in both
 * directions instead of pleating it into a fan, and holding the apices under a
 * common ceiling is what makes the top of the plate flat rather than domed.
 */
function dragonBlood(_parameters: TreeParameters, site: CrownSite): DichotomyPolicy {
  const ceiling = site.ceiling
  const reach = site.reach
  const headroom = headroomOf(site)
  return {
    generationLimit: 6,
    // A plate has to fill its whole disc, so this is the strongest of the four.
    spaceFilling: 0.95,
    // A true continuation: the crown's first axis is the bole carrying on, so
    // it inherits the terminal ring exactly rather than stepping down into it.
    initialRadius: (trunkRadius) => trunkRadius,
    internodeStep: (apex, random) => {
      // Each generation is a little over half the last. The umbrella is a
      // consequence of that ratio, not of bending the branches flat.
      // A tier table, not a geometric decay from a long first segment. The
      // first internode used to be nearly half the crown's headroom, so the
      // handover from a deliberately short bole still rendered as a pole with
      // a fork on top; these keep every tier a comparable slice of the crown.
      const tiers = [0.32, 0.24, 0.17, 0.12, 0.085, 0.06] as const
      const scale = tiers[Math.min(apex.generation, tiers.length - 1)]!
      const remaining = clamp(1 - apex.position.y / ceiling, 0, 1)
      return {
        length: headroom * scale * random.range(0.84, 1.18),
        endRadius: apex.radius * random.range(0.8, 0.88),
        crook: random.signed() * 0.05,
        // Climb while there is headroom, then hold level and finally sag. A
        // branch that keeps rising makes a dome; one simply rotated flat makes
        // a wheel. Growth that runs out of headroom makes a plate.
        rise: apex.generation >= 3
          ? random.range(-0.02, 0.1)
          : lerpNumber(0.02, 0.5, remaining * remaining),
        samples: apex.generation < 2 ? 7 : 5,
      }
    },
    outcome: (apex) => apex.internode >= 1
      // The old crown began with one binary plane, so all sixty-four terminal
      // tips remained descendants of two opposing airspaces and a 120-degree
      // wedge of the mature plate stayed empty. An old Dragon's blood commonly
      // carries several co-dominant primary crown centres; after that initial
      // release, every centre follows the true dichotomous process.
      ? { kind: 'divide', ways: apex.generation === 0 ? 3 : 2 }
      : { kind: 'continue' },
    divide: (apex, ways, random) => {
      // Openings widen with generation: the first fork is nearly upright, the
      // last is almost level, which is what spreads the plate outward.
      // Openings widen fast. By the last generations the daughters leave almost
      // at right angles, which is what carries the plate outward once the
      // apices have stopped climbing.
      const opening = lerpNumber(0.44, 1.34, Math.pow(apex.generation / 5, 0.8)) *
        random.range(0.9, 1.12)
      const plane = apex.splitPlane
      const { crowded, room } = spreadBias(apex, site)
      if (ways === 3) {
        const phase = random.range(-0.35, 0.35)
        return Array.from({ length: 3 }, (_, index) => {
          const spoke = turn(
            plane,
            apex.direction,
            phase + index * Math.PI * 2 / 3,
          )
          const opening = random.range(0.48, 0.62)
          const raw = normalize(add(
            multiply(apex.direction, Math.cos(opening)),
            multiply(spoke, Math.sin(opening)),
          ))
          const direction = forage(raw, spoke, crowded * 0.7, room * 0.72)
          return {
            direction,
            splitPlane: perpendicular(
              direction,
              turn(spoke, direction, planeAdvance(random)),
            ),
            // Leonardo area conservation: three equal daughters should each
            // be close to parent/sqrt(3), not seventy percent of the parent.
            // The previous total cross-sectional area was ~1.5x the bole and
            // rendered as three swollen balls at the first crown junction.
            radius: apex.radius * random.range(0.54, 0.61),
            vigor: random.range(0.92, 1),
            continuation: index === 0,
          }
        })
      }
      return [-1, 1].map((sign, index) => {
        const raw = normalize(add(
          multiply(apex.direction, Math.cos(opening)),
          multiply(plane, Math.sin(opening) * sign),
        ))
        // Under the ceiling the apex turns almost fully horizontal and reaches
        // outward along its own bearing. This is what closes the plate.
        const direction = forage(
          raw,
          multiply(plane, sign),
          crowded * 0.95,
          room * 0.95,
        )
        return {
          direction,
          // Near a right angle to the parent's plane, but never exactly: an
          // exact quarter turn repeats every second generation and the crown
          // fills four azimuths instead of the whole disc.
          splitPlane: perpendicular(direction, turn(plane, direction, planeAdvance(random))),
          radius: apex.radius * random.range(0.74, 0.8),
          vigor: apex.vigor * random.range(0.94, 1),
          continuation: index === 0,
        }
      })
    },
    nodeSwell: (apex) => ({ amount: 1, reach: apex.radius * 3.2 }),
    nodeFlatten: () => 0,
    crown: (apex, axis, random, emit) => {
      // A Dracaena tip carries a tight cluster of small rosettes, not one big
      // one. Small and many is what keeps the woody tiers readable through the
      // crown; a single rosette per apex was a starburst that hid them.
      const tip = axis.samples.at(-1)!
      const heads = random.integer(2, 3)
      for (let head = 0; head < heads; head += 1) {
        const spoke = turn(apex.splitPlane, apex.direction, random.range(0, Math.PI * 2))
        const offset = head === 0 ? 0 : random.range(0.25, 0.7)
        emit({
          partId: axis.id,
          center: add(
            add(tip.position, multiply(apex.direction, tip.radius * 0.8)),
            multiply(spoke, reach * 0.075 * offset),
          ),
          axis: normalize(add(apex.direction, vec3(0, 0.42, 0))),
          radius: reach * 0.058 * random.range(0.86, 1.2),
          depth: reach * 0.04 * random.range(0.84, 1.16),
          occlusion: random.range(0.02, 0.22),
          organModel: 'terminal-rosette',
          seed: seedFrom(random),
        })
      }
    },
  }
}

/**
 * Aloidendron dichotomum — the candelabrum.
 *
 * The quiver tree divides rarely, and never evenly: one daughter keeps most of
 * the girth and stays near the parent's bearing while the other leans away and
 * often fails outright. Long runs between those few divisions are what leaves
 * the thick, sparse, obviously hand-built silhouette, and the split plane
 * advances by a golden angle so no two forks share an axis.
 */
function quiverTree(_parameters: TreeParameters, site: CrownSite): DichotomyPolicy {
  const reach = site.reach
  const headroom = headroomOf(site)
  return {
    generationLimit: 5,
    // A candelabrum is allowed to be lopsided; it just must not be one-sided.
    spaceFilling: 0.5,
    initialRadius: (trunkRadius) => trunkRadius * 0.86,
    internodeStep: (apex, random) => {
      // Elongation slows as the tree fills the height it was authored to reach.
      // Without this the run count alone decides how tall it gets, and a policy
      // that forks rarely simply grows past its own ceiling.
      const { crowded } = spreadBias(apex, site)
      const slowing = clamp(1 - crowded, 0.22, 1)
      const tiers = [0.22, 0.18, 0.145, 0.115, 0.085] as const
      const scale = tiers[Math.min(apex.generation, tiers.length - 1)]!
      return {
        // Vigor modulates elongation; it must not multiply it away. Used raw
        // it compounds every generation, and by the fourth an axis moved a
        // centimetre — which is why the crown's whole plan was set by its first
        // two branches and sat in one quadrant.
        length: headroom * scale *
          lerpNumber(0.55, 1, apex.vigor) * slowing * random.range(0.84, 1.18),
        // Quiver wood barely tapers between forks; it steps down at them.
        endRadius: apex.radius * random.range(0.9, 0.95),
        crook: random.signed() * 0.1,
        rise: random.range(0.12, 0.34) * slowing,
        samples: 6,
      }
    },
    outcome: (apex, random) => {
      // Long runs. Two or three internodes of clean wood before anything
      // happens is most of why the tree reads as chunky rather than twiggy.
      if (apex.internode < 1) return { kind: 'continue' }
      // Survival is what makes a candelabrum multi-order. Retiring an arm as
      // soon as its vigor dipped left one tall Y with two heads on it.
      if (apex.vigor < 0.22) return { kind: 'crown' }
      // The first three orders establish the candelabrum. Later arms divide
      // only when they retain enough vigour, so the mature tree carries a
      // few dozen unequal heads rather than duplicating Dragon's 96 tips.
      const probability = apex.generation < 3
        ? 1
        : apex.generation === 3 ? 0.76 : 0.44
      return random.unit() < probability
        ? { kind: 'divide', ways: 2 }
        : { kind: 'crown' }
    },
    divide: (apex, _ways, random) => {
      const plane = apex.splitPlane
      const dominantSide = random.unit() < 0.5 ? -1 : 1
      const { crowded, room } = spreadBias(apex, site)
      return [dominantSide, -dominantSide].map((sign, index) => {
        const dominant = index === 0
        // Arms that leave at ten degrees make a broom, not a candelabrum.
        const opening = dominant
          ? random.range(0.28, 0.46)
          : random.range(0.58, 0.92)
        const raw = normalize(add(
          add(
            multiply(apex.direction, Math.cos(opening)),
            multiply(plane, Math.sin(opening) * sign),
          ),
          vec3(0, 0.12, 0),
        ))
        // A candelabrum keeps climbing much longer than an umbrella, so it
        // levels off only weakly — but it still has to stop at the ceiling.
        const direction = forage(
          raw,
          multiply(plane, sign),
          crowded * (dominant ? 0.46 : 0.74),
          room * (dominant ? 0.6 : 1.15),
        )
        return {
          direction,
          splitPlane: perpendicular(direction, turn(plane, direction, GOLDEN_ANGLE)),
          radius: apex.radius * (dominant
            ? random.range(0.78, 0.85)
            : random.range(0.54, 0.66)),
          vigor: apex.vigor * (dominant
            ? random.range(0.9, 1)
            : random.range(0.62, 0.84)),
          continuation: dominant,
        }
      })
    },
    // Fork character is built by the embedded daughter union. Expanding and
    // flattening the entire terminal ring at every order produced a serrated
    // pipe, not reaction wood.
    nodeSwell: (apex) => ({ amount: 1, reach: apex.radius * 3.8 }),
    nodeFlatten: () => 0,
    crown: (apex, axis, random, emit) => {
      const tip = axis.samples.at(-1)!
      emit({
        partId: axis.id,
        center: add(tip.position, multiply(apex.direction, tip.radius * 0.9)),
        axis: normalize(add(apex.direction, vec3(0, 0.55, 0))),
        radius: reach * 0.095 * random.range(0.86, 1.16),
        depth: reach * 0.075 * random.range(0.84, 1.12),
        occlusion: random.range(0.02, 0.16),
        organModel: 'terminal-rosette',
        seed: seedFrom(random),
      })
    },
  }
}

/**
 * Yucca brevifolia — architecture as a record of damage.
 *
 * A Joshua tree's apex does not divide on a schedule. It runs until something
 * kills the meristem — a flowering, a moth, a frost — and only then do several
 * lateral buds release at once. Two, three or four shoots leave the same node
 * at irregular azimuths, which is why the tree is angular and lopsided rather
 * than dichotomous in the strict sense, and why no two are alike. Dead leaves
 * are retained as a shaggy skirt below every rosette.
 */
function joshuaTree(_parameters: TreeParameters, site: CrownSite): DichotomyPolicy {
  const reach = site.reach
  const headroom = headroomOf(site)
  return {
    generationLimit: 4,
    // Multiple crown centres, so the heads have to find their own airspace.
    spaceFilling: 0.85,
    initialRadius: (trunkRadius) => trunkRadius * 0.9,
    internodeStep: (apex, random) => {
      const { crowded } = spreadBias(apex, site)
      const slowing = clamp(1 - crowded, 0.45, 1)
      return {
        length: headroom * lerpNumber(0.42, 0.2, apex.generation / 4) *
          lerpNumber(0.5, 1, apex.vigor) * slowing * random.range(0.7, 1.3),
        endRadius: apex.radius * random.range(0.88, 0.95),
        // Sharp changes of bearing between internodes: the angular, elbowed
        // wood that a smooth taper cannot produce.
        crook: random.signed() * random.range(0.16, 0.34),
        rise: random.range(-0.1, 0.42) * slowing,
        samples: 6,
      }
    },
    outcome: (apex, random) => {
      // Damage releases become less likely on already reiterated shoots. A
      // constant high hazard compounded into fifty heads and erased the open,
      // angular crown under a ball of retained leaves.
      const hazard = [0.62, 0.44, 0.28, 0.14][
        Math.min(apex.generation, 3)
      ]!
      if (random.unit() < hazard || (apex.generation === 0 && apex.internode >= 2)) {
        apex.damaged = true
        const ways = apex.generation === 0 && random.unit() < 0.28
          ? 4
          : random.integer(2, 3)
        return { kind: 'divide', ways }
      }
      if (apex.internode >= 3) return { kind: 'crown' }
      return { kind: 'continue' }
    },
    divide: (apex, ways, random) => {
      const plane = apex.splitPlane
      const phase = random.range(0, Math.PI * 2)
      const { crowded, room } = spreadBias(apex, site)
      return Array.from({ length: ways }, (_, index) => {
        // Buds release around the whole node, not across one plane. This is the
        // structural difference from a true dichotomy and it is what stops the
        // crown reading as a flat antler.
        const azimuth = phase + (index / ways) * Math.PI * 2 +
          random.range(-0.6, 0.6)
        const opening = random.range(0.52, 1.18)
        // Lateral buds are released by the *node*, so their bearings belong to
        // the node's own frame. Building them mostly out of the parent's
        // direction meant a leaning stem threw its entire crown downwind: plan
        // review found every tip inside a single quadrant.
        const spoke = turn(plane, apex.direction, azimuth)
        const raw = normalize(add(
          add(
            multiply(apex.direction, Math.cos(opening) * 0.62),
            multiply(spoke, Math.sin(opening) * 1.12),
          ),
          vec3(0, 0.5, 0),
        ))
        const direction = forage(
          raw,
          spoke,
          crowded * random.range(0.4, 0.85),
          room * random.range(0.6, 1.25),
        )
        return {
          direction,
          splitPlane: perpendicular(direction, spoke),
          radius: apex.radius * random.range(0.56, 0.78),
          vigor: apex.vigor * random.range(0.5, 0.92),
          // The strongest release takes over the axis; the rest are reiterated
          // crown centres in their own right.
          continuation: index === 0,
        }
      })
    },
    nodeSwell: (apex) => ({ amount: 1, reach: apex.radius * 3 }),
    nodeFlatten: () => 0,
    crown: (apex, axis, random, emit) => {
      const tip = axis.samples.at(-1)!
      emit({
        partId: axis.id,
        center: add(tip.position, multiply(apex.direction, tip.radius * 0.7)),
        axis: normalize(add(apex.direction, vec3(0, 0.5, 0))),
        radius: reach * 0.115 * random.range(0.84, 1.16),
        depth: reach * 0.09 * random.range(0.82, 1.12),
        occlusion: random.range(0.02, 0.2),
        organModel: 'terminal-rosette',
        seed: seedFrom(random),
      })
    },
    skirt: (apex, axis, random, emit) => {
      // Dead leaves stay attached and hang back against the stem. Without them
      // a Joshua tree is a bare stick with a pompom on the end.
      const rows = random.integer(2, 3)
      for (let row = 0; row < rows; row += 1) {
        const along = 1 - (row + 1) * random.range(0.06, 0.11)
        if (along < 0.25) break
        emit({
          partId: axis.id,
          center: sampleAxisPosition(axis.samples, along),
          axis: normalize(add(multiply(apex.direction, 0.25), vec3(0, -0.9, 0))),
          radius: reach * 0.065 * random.range(0.82, 1.08),
          depth: reach * 0.06 * random.range(0.8, 1.06),
          occlusion: random.range(0.3, 0.72),
          senescence: clamp(0.55 + row * 0.12, 0, 1),
          organModel: 'terminal-rosette',
          seed: seedFrom(random),
        })
      }
    },
  }
}

/**
 * Hyphaene thebaica — the branching palm.
 *
 * The doum is the only palm that forks, and it does so twice in a lifetime at a
 * genuine terminal dichotomy, with long clean stipe between the events. Each
 * surviving apex carries a fan crown built from several leaf ages at once: an
 * erect spear, arching mature fronds and a retained skirt of dead ones hanging
 * below horizontal. Emitting one ring of identical fronds is what made the head
 * read as a pinwheel.
 */
function doumPalm(parameters: TreeParameters, site: CrownSite): DichotomyPolicy {
  const reach = site.reach
  const headroom = headroomOf(site)
  return {
    generationLimit: 3,
    // Only a handful of heads; they need separating, not scattering.
    spaceFilling: 0.4,
    initialRadius: (trunkRadius) => trunkRadius * 0.96,
    internodeStep: (apex, random) => {
      // Long, clean, barely tapering stipe: a palm has no secondary thickening.
      // Measured against the headroom this apex *still has*, so elongation
      // converges on the tree's mature height instead of accumulating past it.
      const remaining = clamp(site.ceiling - apex.position.y, 0.5, headroom)
      const tiers = [0.34, 0.27, 0.2] as const
      return {
        length: headroom * tiers[Math.min(apex.generation, 2)]! *
          clamp(remaining / headroom, 0.38, 1) *
          random.range(0.82, 1.2),
        endRadius: apex.radius * random.range(0.93, 0.98),
        crook: random.signed() * 0.12,
        rise: random.range(0.24, 0.56) * clamp(remaining / headroom, 0.2, 1),
        samples: 6,
      }
    },
    outcome: (apex) => {
      if (apex.generation >= 2) {
        return apex.internode >= 2 ? { kind: 'crown' } : { kind: 'continue' }
      }
      // One clean internode, then the division. A palm cannot thicken to
      // support an arbitrarily long stipe, and stacking runs is what put the
      // first fork at the very top of a pole.
      return { kind: 'divide', ways: 2 }
    },
    divide: (apex, _ways, random) => {
      const plane = apex.splitPlane
      // Wide enough that the two stipes stand clear of each other and each
      // head reads as its own crown rather than merging into one carpet.
      const opening = random.range(0.56, 0.82)
      const { crowded, room } = spreadBias(apex, site)
      return [-1, 1].map((sign, index) => {
        const raw = normalize(add(
          add(
            multiply(apex.direction, Math.cos(opening)),
            multiply(plane, Math.sin(opening) * sign),
          ),
          vec3(0, 0.22, 0),
        ))
        // A doum keeps its stipes steep; it only needs enough separation for
        // each head to stand clear of its sibling.
        const direction = forage(
          raw,
          multiply(plane, sign),
          crowded * 0.34,
          room * 0.45,
        )
        return {
          direction,
          splitPlane: perpendicular(direction, turn(plane, direction, planeAdvance(random))),
          // Two equal stipes. A palm cannot thicken later, so both daughters
          // leave at very nearly the girth they will keep for good.
          radius: apex.radius * random.range(0.82, 0.88),
          vigor: apex.vigor * random.range(0.92, 1),
          continuation: index === 0,
        }
      })
    },
    nodeSwell: (apex) => ({ amount: 1, reach: apex.radius * 2.2 }),
    nodeFlatten: () => 0,
    crown: (apex, axis, random, emit) => {
      const tip = axis.samples.at(-1)!
      const count = Math.max(9, Math.round(parameters.foliageDensity * 12))
      const phase = random.range(0, Math.PI * 2)
      const up = normalize(add(apex.direction, vec3(0, 0.4, 0)))
      for (let index = 0; index < count; index += 1) {
        // Age runs from the newest spear at the centre to the oldest frond on
        // the outside, and the lift follows it from erect to hanging.
        const age = index / Math.max(1, count - 1)
        const azimuth = phase + index * GOLDEN_ANGLE + random.range(-0.12, 0.12)
        const spoke = turn(apex.splitPlane, apex.direction, azimuth)
        const lift = lerpNumber(0.95, -0.35, Math.pow(age, 0.85)) +
          random.range(-0.08, 0.08)
        const frond = normalize(add(multiply(spoke, 1), multiply(up, lift)))
        emit({
          partId: axis.id,
          center: add(tip.position, multiply(frond, tip.radius * 0.6)),
          axis: frond,
          radius: reach * 0.23 * random.range(age < 0.1 ? 0.5 : 0.86, 1.1),
          depth: reach * 0.34 * random.range(age < 0.1 ? 0.42 : 0.88, 1.08),
          occlusion: random.range(0.02, 0.26),
          senescence: age > 0.78 ? clamp((age - 0.78) / 0.22, 0, 1) : 0,
          development: age < 0.1 ? lerpNumber(0.2, 0.8, age / 0.1) : 1,
          organModel: 'frond',
          seed: seedFrom(random),
        })
      }
    },
  }
}

type PolicyFactory = (parameters: TreeParameters, site: CrownSite) => DichotomyPolicy

const POLICIES: Partial<Record<TreeSpecies, PolicyFactory>> = {
  'dragon-blood': dragonBlood,
  'quiver-tree': quiverTree,
  'joshua-tree': joshuaTree,
  'doum-palm': doumPalm,
}

export function dichotomyPolicy(
  parameters: TreeParameters,
  site: CrownSite,
): DichotomyPolicy {
  return (POLICIES[parameters.species] ?? dragonBlood)(parameters, site)
}

/** Apex identity for a species whose crown starts at a given generation. */
export function dichotomyStartsUpright(species: TreeSpecies): boolean {
  return species !== 'joshua-tree'
}

/** Small helper kept here so the process module owns no species knowledge. */
export function initialSplitPlane(
  direction: { x: number; y: number; z: number },
  seed: number,
): { x: number; y: number; z: number } {
  const angle = (seed % 1000) / 1000 * Math.PI * 2
  return perpendicular(
    normalize(direction),
    vec3(Math.cos(angle), 0, Math.sin(angle)),
  )
}

export type { Apex }
