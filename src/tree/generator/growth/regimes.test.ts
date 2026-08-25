import { describe, expect, it } from 'vitest'
import { generateSemanticTree } from '../semanticGraph'
import { dot, normalize, subtract } from '../math'
import {
  DEFAULT_TREE_ENVIRONMENT,
  TREE_SPECIES_PRESETS,
  type SemanticTreeGraph,
  type TreeSpecies,
} from '../types'

function graph(species: TreeSpecies): SemanticTreeGraph {
  return generateSemanticTree(TREE_SPECIES_PRESETS[species], DEFAULT_TREE_ENVIRONMENT)
}

function polylineLength(
  samples: readonly { position: { x: number; y: number; z: number } }[],
): number {
  let total = 0
  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1]!.position
    const b = samples[index]!.position
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  }
  return total
}

describe('reusable growth regimes', () => {
  it('builds Ceiba as a tall buttressed column with explicit high scaffolds', () => {
    const tree = graph('kapok-ceiba')
    const trunk = tree.parts.find((part) => part.id === 'trunk')!
    const primaries = tree.parts.filter((part) => /^regime-primary-\d+$/.test(part.id))
    expect(trunk.spine.at(-1)!.position.y).toBeGreaterThan(30)
    expect(trunk.spine[0]!.crossSection.fins?.length ?? 0).toBeGreaterThanOrEqual(5)
    expect(primaries).toHaveLength(TREE_SPECIES_PRESETS['kapok-ceiba'].branchCount)
    expect(primaries.every((part) => part.attachment > 0.55)).toBe(true)
  })

  it('builds a baobab as a valid massive lobed bole with outward heavy ramification', () => {
    const tree = graph('baobab')
    const trunk = tree.parts.find((part) => part.id === 'trunk')!
    const lower = trunk.spine[Math.floor(trunk.spine.length * 0.35)]!.radius
    const top = trunk.spine.at(-1)!.radius
    // The storage bole is still massive where it divides. The old band required
    // the top to be under three fifths of the mid girth, which is the vase neck
    // that made the divisions read as pipes pushed into a bottle; a real bole
    // hands roughly two thirds of its girth on to its limbs. Detailed bole
    // anatomy is covered by baobabTopology.test.ts.
    expect(lower / top).toBeGreaterThan(1.2)
    expect(lower / top).toBeLessThan(1.9)
    // The plan is a union of fused stems rather than a rippled ellipse, so the
    // outline lives in `fusedStems` and `lobeStrength` is deliberately zero.
    expect(trunk.spine.every((sample) =>
      (sample.crossSection.fusedStems?.length ?? 0) >= 3)).toBe(true)
    for (let index = 1; index < trunk.spine.length - 1; index += 1) {
      const previous = trunk.spine[index - 1]!
      const current = trunk.spine[index]!
      const next = trunk.spine[index + 1]!
      const a = normalize(subtract(current.position, previous.position))
      const b = normalize(subtract(next.position, current.position))
      const turn = Math.acos(Math.max(-1, Math.min(1, dot(a, b))))
      const run = Math.hypot(
        next.position.x - previous.position.x,
        next.position.y - previous.position.y,
        next.position.z - previous.position.z,
      )
      // A swept tube folds through itself once local curvature exceeds its
      // own radius. This guards the giant diagonal belt caught in visual QA.
      expect(turn * current.radius / Math.max(0.001, run)).toBeLessThan(0.42)
    }
    const divisions = tree.parts.filter((part) => /^baobab-division-\d+$/.test(part.id))
    const crownAxes = tree.parts.filter((part) => part.id.startsWith('baobab-'))
    expect(divisions.length).toBeGreaterThanOrEqual(4)
    expect(divisions.length).toBeLessThanOrEqual(6)
    // One division inherits the bole; the others divide or emerge from its
    // unequal upper lobes. A radial ring of identical side branches is the
    // rejected topology this dedicated regime replaced.
    expect(divisions.filter((part) => part.junctionType === 'continuation'))
      .toHaveLength(1)
    expect(divisions.filter((part) => part.attachment === 1).length).toBe(1)
    // Divisions leave a band of the shoulder, not one ring — but all of them
    // leave the *top* of the bole. Scattering them down the flank produced the
    // octopus reading the dedicated regime replaced.
    expect(divisions.some((part) => part.attachment < 0.99)).toBe(true)
    expect(divisions.every((part) => part.attachment >= 0.88)).toBe(true)
    const divisionLengths = divisions.map((part) => polylineLength(part.spine))
    expect(Math.max(...divisionLengths) / Math.min(...divisionLengths)).toBeGreaterThan(1.2)
    expect(Math.max(...crownAxes.map((part) => part.branchOrder))).toBeGreaterThanOrEqual(4)
    expect(crownAxes.filter((part) => part.branchOrder >= 3).length)
      .toBeGreaterThanOrEqual(35)
    expect(tree.foliageClusters.length).toBeGreaterThanOrEqual(70)
    expect(tree.foliageClusters.every((cluster) => {
      const bearer = tree.parts.find((part) => part.id === cluster.partId)
      return bearer?.id.startsWith('baobab-') && bearer.branchOrder >= 4
    })).toBe(true)
  })

  it('builds live oak from a true fork, ramified crown wood, and attached foliage', () => {
    const tree = graph('live-oak')
    const byId = new Map(tree.parts.map((part) => [part.id, part]))
    const primaries = tree.parts.filter((part) => /^regime-primary-\d+$/.test(part.id))
    const tertiaries = tree.parts.filter((part) => part.id.includes('-tertiary-'))

    expect(primaries).toHaveLength(TREE_SPECIES_PRESETS['live-oak'].branchCount)
    expect(primaries.filter((part) => part.junctionType === 'continuation')).toHaveLength(1)
    const continuations = tree.parts.filter((part) => part.junctionType === 'continuation')
    expect(continuations.every((part) => part.attachment === 1)).toBe(true)
    for (const continuation of continuations) {
      const parent = byId.get(continuation.parentId!)!
      expect(junctionTangentCosine(parent.spine, continuation.spine)).toBeGreaterThan(0.88)
      expect(continuation.spine[0]!.radius / parent.spine.at(-1)!.radius)
        .toBeGreaterThan(0.78)
    }
    expect(tertiaries.length).toBeGreaterThanOrEqual(80)
    for (const cluster of tree.foliageClusters) {
      const bearer = byId.get(cluster.partId)
      expect(bearer).toBeDefined()
      // The station centre may sit off the explicit centreline because one
      // station represents a whole leafy twiglet volume, not a single leaf.
      // It must still overlap its bearer, which keeps every crown lobe visibly
      // supported without forcing the canopy back into linear ribbons.
      expect(distanceToSpine(cluster.center, bearer!.spine))
        .toBeLessThan(cluster.radius * 1.05)
    }

    const trunk = byId.get('trunk')!
    const highFlare = trunk.spine.filter((sample) => sample.position.y > 1.5)
    expect(highFlare.every((sample) =>
      (sample.crossSection.fins ?? []).every((fin) => fin.strength < 0.01),
    )).toBe(true)
    const structuralRoots = tree.parts.filter((part) =>
      part.type === 'root' && part.parentId === trunk.id)
    expect(structuralRoots.filter((root) => root.spine.some((sample) => {
      const start = root.spine[0]!.position
      const run = Math.hypot(sample.position.x - start.x, sample.position.z - start.z)
      const crown = sample.position.y + sample.crossSection.radiusZ
      return run > 0.35 && crown > 0.05
    })).length).toBeGreaterThanOrEqual(4)
  })

  it('keeps a coconut palm monopodial with a crown bud and swept petioles', () => {
    const tree = graph('coconut-palm')
    const trunk = tree.parts.find((part) => part.id === 'trunk')!
    const bud = tree.parts.find((part) => part.id === 'regime-apical-bud')!
    const petioles = tree.parts.filter((part) =>
      part.id.startsWith('regime-apical-petiole-'))
    expect(bud.parentId).toBe(trunk.id)
    expect(bud.junctionType).toBe('continuation')
    expect(trunk.continuationChildId).toBe(bud.id)
    expect(tree.foliageClusters.length).toBeGreaterThanOrEqual(12)
    expect(petioles).toHaveLength(tree.foliageClusters.length)
    expect(tree.foliageClusters.every((organ) => organ.organModel === 'frond')).toBe(true)
    expect(tree.foliageClusters.every((organ) =>
      organ.partId.startsWith('regime-apical-petiole-'))).toBe(true)
    const trunkTop = trunk.spine.at(-1)!.position.y
    expect(Math.min(...tree.foliageClusters.map((organ) => organ.center.y)))
      .toBeGreaterThan(trunkTop - 1)
  })

  it('closes dragon-blood into a flat wide umbrella plate', () => {
    const tree = graph('dragon-blood')
    const axes = tree.parts.filter((part) => part.id.startsWith('dichotomy'))
    const tips = axes.filter((part) => part.children.length === 0)
    const trunk = tree.parts.find((part) => part.id === 'trunk')!
    const boleTop = trunk.spine.at(-1)!.position.y

    // Every apex divides at every flowering, so the surviving tip count is
    // large. Counting axes is not the point; the shape they close into is.
    expect(tips.length).toBeGreaterThanOrEqual(40)
    expect(tree.foliageClusters.every((organ) =>
      organ.organModel === 'terminal-rosette')).toBe(true)

    // A plate: the tips sit in a shallow band, and that band is far wider than
    // it is deep. The rejected version was a globe on a pole.
    const heights = tips.map((part) => part.spine.at(-1)!.position.y).sort((a, b) => a - b)
    const band = heights.at(-1)! - heights[0]!
    const reach = Math.max(...tips.map((part) => Math.hypot(
      part.spine.at(-1)!.position.x,
      part.spine.at(-1)!.position.z,
    )))
    expect(reach * 2).toBeGreaterThan(band * 2.2)
    expect(heights[0]!).toBeGreaterThan(boleTop)

    // And it fills its own plan rather than collapsing into one quadrant.
    const sectors = new Array(12).fill(0)
    for (const tip of tips) {
      const position = tip.spine.at(-1)!.position
      const angle = Math.atan2(position.z, position.x)
      sectors[Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 12) % 12] += 1
    }
    expect(sectors.filter((count) => count > 0).length).toBeGreaterThanOrEqual(9)

    // A fork is fused by the embedded daughter union. Expanding the complete
    // terminal ring at every division made the continuation silhouette pulse
    // into a necklace of diamond-shaped bosses, so the semantic sweep itself
    // must remain locally round and radius-continuous.
    for (const part of axes.filter((candidate) => candidate.children.length > 0)) {
      const end = part.spine.at(-1)!
      const aspect = Math.max(end.crossSection.radiusX, end.crossSection.radiusZ) /
        Math.min(end.crossSection.radiusX, end.crossSection.radiusZ)
      expect(aspect).toBeLessThan(1.08)
      const continuation = part.continuationChildId
        ? tree.parts.find((candidate) => candidate.id === part.continuationChildId)
        : undefined
      if (continuation) {
        expect(continuation.spine[0]!.radius / end.radius).toBeCloseTo(1, 4)
      }
    }
  })

  it('builds Norway spruce from radial tiers with real hanging branchlets', () => {
    const tree = graph('norway-spruce')
    const tiers = tree.parts.filter((part) => /^whorl-\d+-\d+$/.test(part.id))
    const drops = tree.parts.filter((part) => part.id.includes('-drop-'))
    expect(tiers.length).toBeGreaterThan(50)
    expect(drops.length).toBe(tiers.length * 2)
    expect(tree.foliageClusters.every((organ) => organ.organModel === 'needle-spray'))
      .toBe(true)
  })

  it('separates redwood and monkey-puzzle tier architecture from spruce', () => {
    const redwood = graph('coast-redwood')
    const monkeyPuzzle = graph('monkey-puzzle')
    const redwoodTiers = redwood.parts.filter((part) => /^whorl-\d+-\d+$/.test(part.id))
    const monkeyTiers = monkeyPuzzle.parts.filter((part) => /^whorl-\d+-\d+$/.test(part.id))

    expect(redwoodTiers.length).toBeGreaterThan(65)
    expect(redwood.parts.some((part) => part.id.includes('-drop-'))).toBe(true)
    expect(monkeyTiers.length).toBeGreaterThan(30)
    expect(monkeyPuzzle.parts.some((part) => part.id.includes('-drop-'))).toBe(false)
    expect(monkeyPuzzle.foliageClusters.every((organ) =>
      organ.organModel === 'scale-foliage')).toBe(true)
  })

  it('gives date palms and tree ferns distinct apical frond crowns', () => {
    const datePalm = graph('date-palm')
    const treeFern = graph('tree-fern')

    const datePetioles = datePalm.parts.filter((part) =>
      part.id.startsWith('regime-apical-petiole-'))
    const fernPetioles = treeFern.parts.filter((part) =>
      part.id.startsWith('regime-apical-petiole-'))
    expect(datePetioles).toHaveLength(datePalm.foliageClusters.length)
    expect(fernPetioles).toHaveLength(treeFern.foliageClusters.length)
    expect(datePalm.parts.some((part) => part.id === 'regime-apical-bud')).toBe(true)
    expect(treeFern.parts.some((part) => part.id === 'regime-apical-bud')).toBe(true)
    expect(datePalm.foliageClusters.length).toBeGreaterThan(treeFern.foliageClusters.length)
    expect(datePalm.bounds.max.y).toBeGreaterThan(treeFern.bounds.max.y * 1.5)
  })

  it('builds the quiver tree from few, strongly unequal divisions', () => {
    const quiver = graph('quiver-tree')
    const dragon = graph('dragon-blood')
    const byId = new Map(quiver.parts.map((part) => [part.id, part]))
    const quiverTips = quiver.parts.filter((part) =>
      part.id.startsWith('dichotomy') && part.children.length === 0)
    const dragonTips = dragon.parts.filter((part) =>
      part.id.startsWith('dichotomy') && part.children.length === 0)

    // A candelabrum carries far fewer arms than an umbrella carries tips.
    expect(dragonTips.length).toBeGreaterThan(quiverTips.length * 1.7)
    expect(quiver.foliageClusters.every((organ) =>
      organ.organModel === 'terminal-rosette')).toBe(true)

    // Never even: one daughter keeps most of the girth at every division.
    let unequal = 0
    let divisions = 0
    for (const part of quiver.parts) {
      const children = part.children
        .map((id) => byId.get(id))
        .filter((child): child is NonNullable<typeof child> => Boolean(child))
      if (children.length !== 2) continue
      divisions += 1
      const radii = children.map((child) => child.spine[0]!.radius).sort((a, b) => b - a)
      if (radii[0]! > radii[1]! * 1.12) unequal += 1
    }
    expect(divisions).toBeGreaterThan(3)
    expect(unequal / divisions).toBeGreaterThan(0.7)
  })

  it('makes Doum a bifurcating palm with age-layered fan crowns', () => {
    const tree = graph('doum-palm')
    const axes = tree.parts.filter((part) => part.id.startsWith('dichotomy'))
    const tips = axes.filter((part) => part.children.length === 0)

    // Two genuine lifetime divisions, so several separate heads — not one head
    // with a fork under it.
    expect(tips.length).toBeGreaterThanOrEqual(3)
    expect(tips.length).toBeLessThanOrEqual(8)
    expect(tree.foliageClusters.every((organ) => organ.organModel === 'frond')).toBe(true)
    const carriers = new Set(tree.foliageClusters.map((organ) => organ.partId))
    expect(carriers.size).toBe(tips.length)

    // Each head carries several leaf ages at once: an unopened spear, mature
    // fronds, and a retained skirt of dry ones.
    expect(tree.foliageClusters.some((organ) => (organ.development ?? 1) < 0.9)).toBe(true)
    expect(tree.foliageClusters.some((organ) => (organ.senescence ?? 0) > 0.2)).toBe(true)
    const lifts = tree.foliageClusters.map((organ) => organ.axis.y)
    expect(Math.max(...lifts)).toBeGreaterThan(0.4)
    expect(Math.min(...lifts)).toBeLessThan(-0.1)

    // The stipes stay near their authored girth: a palm cannot thicken later.
    for (const axis of axes) {
      // A continuation's first station is the inherited parent junction ring,
      // not the daughter stipe's own settled girth. Measure beyond that short
      // emergence zone so this guards palm taper rather than rejecting a
      // topologically continuous fork.
      const first = axis.spine[Math.min(
        axis.spine.length - 1,
        Math.max(1, Math.ceil(axis.spine.length * 0.32)),
      )]!.radius
      const last = axis.spine.at(-1)!.radius
      expect(last).toBeGreaterThan(first * 0.8)
    }
  })

  it('records damage in Joshua tree architecture and retains a skirt', () => {
    const tree = graph('joshua-tree')
    const byId = new Map(tree.parts.map((part) => [part.id, part]))
    const axes = tree.parts.filter((part) => part.id.startsWith('dichotomy'))

    // A killed apex releases several buds at once, so some nodes carry more
    // than two daughters. A strict dichotomy never can.
    const wayCounts = axes.map((part) => part.children.filter((id) =>
      byId.get(id)?.id.startsWith('dichotomy')).length)
    expect(wayCounts.some((count) => count > 2)).toBe(true)
    expect(wayCounts.filter((count) => count >= 2).length).toBeGreaterThan(3)

    // Run lengths are irregular because the trigger is a hazard, not a counter.
    const runs = axes.map((part) => part.spine.length)
    expect(new Set(runs).size).toBeGreaterThan(1)

    // Dead leaves are retained below every living rosette.
    expect(tree.foliageClusters.some((organ) => (organ.senescence ?? 0) > 0.4)).toBe(true)
    expect(tree.foliageClusters.every((organ) =>
      organ.organModel === 'terminal-rosette')).toBe(true)
  })

  it('raises Pandanus stilt roots above its base beneath an apical frond crown', () => {
    const tree = graph('screw-pine-pandanus')
    const roots = tree.parts.filter((part) => part.type === 'root' && part.branchOrder === 1)

    expect(roots).toHaveLength(TREE_SPECIES_PRESETS['screw-pine-pandanus'].rootCount)
    expect(roots.filter((root) => root.attachment > 0.1).length)
      .toBeGreaterThanOrEqual(Math.floor(roots.length * 0.6))
    expect(tree.foliageClusters.every((organ) => organ.organModel === 'frond')).toBe(true)
  })

  it('gives bristlecone a snapped deadwood crown rather than a regular conifer cone', () => {
    const tree = graph('bristlecone-pine')
    const deadSpars = tree.parts.filter((part) => part.id.startsWith('dead-spar-'))
    const deadStubs = tree.parts.filter((part) => part.id.startsWith('dead-stub-'))

    expect(deadSpars.length).toBeGreaterThanOrEqual(3)
    expect(deadStubs.length).toBeGreaterThanOrEqual(1)
    expect(tree.foliageClusters.every((organ) => organ.organModel === 'needle-spray'))
      .toBe(true)
  })

  it('hangs banyan pillar roots from crown limbs instead of the trunk base', () => {
    const tree = graph('banyan')
    const pillars = tree.parts.filter((part) => part.id.startsWith('aerial-root-'))
    const byId = new Map(tree.parts.map((part) => [part.id, part]))

    expect(pillars.length).toBeGreaterThanOrEqual(8)
    expect(pillars.every((root) => {
      const parentType = byId.get(root.parentId!)?.type
      return parentType === 'branch' || parentType === 'twig'
    })).toBe(true)
    expect(pillars.every((root) => root.spine[0]!.position.y >
      root.spine.at(-1)!.position.y)).toBe(true)

    for (const pillar of pillars) {
      // The space solver holds soil-bound roots at the surface. Applying that
      // to a pillar flattened its whole descent onto the terrain and left the
      // single segment back to the carrier standing through the canopy as a
      // capped pole, which is what visual review rejected.
      expect(pillar.aerial).toBe(true)
      const heights = pillar.spine.map((sample) => sample.position.y)
      const midway = heights[Math.floor(heights.length / 2)]!
      expect(midway).toBeGreaterThan(heights.at(-1)! + 1)
      expect(heights[0]! - midway).toBeGreaterThan(1)
      // Monotonic descent: a support root does not climb back up.
      for (let index = 1; index < heights.length; index += 1) {
        expect(heights[index]!).toBeLessThanOrEqual(heights[index - 1]! + 1e-6)
      }
      // Thinner than the limb it hangs from, thicker where it is anchored.
      const carrier = byId.get(pillar.parentId!)!
      const widest = Math.max(...carrier.spine.map((sample) => sample.radius))
      expect(pillar.spine[0]!.radius).toBeLessThan(widest)
      expect(pillar.spine.at(-1)!.radius).toBeGreaterThan(pillar.spine[0]!.radius)
      // Ends below grade, so no cap disc lies on the ground.
      expect(pillar.spine.at(-1)!.position.y).toBeLessThan(0)
    }
    // Pillars arrive in clusters and fuse into a few columns rather than
    // standing as one evenly spaced ring of stilts.
    const feet = pillars.map((root) => root.spine.at(-1)!.position)
    const paired = feet.filter((foot) => feet.some((other) =>
      other !== foot &&
      Math.hypot(other.x - foot.x, other.z - foot.z) < 1.4))
    expect(paired.length / feet.length).toBeGreaterThan(0.5)
  })

  it('grows mangrove prop roots as a steep arching cage, not a low tangle', () => {
    const tree = graph('mangrove')
    const byId = new Map(tree.parts.map((part) => [part.id, part]))
    const props = tree.parts.filter((part) => part.id.startsWith('prop-root-'))

    expect(props.length).toBeGreaterThanOrEqual(8)
    // Rhizophora stilts leave the stems and the low limbs alike; restricting
    // them to the stems produced one ring of arches around the base instead of
    // a cage stacked in height.
    expect(props.some((root) => byId.get(root.parentId!)?.type === 'trunk')).toBe(true)
    // Never wider than the wood it hangs from.
    for (const root of props) {
      const parent = byId.get(root.parentId!)!
      const widest = Math.max(...parent.spine.map((sample) => sample.radius))
      expect(root.spine[0]!.radius).toBeLessThan(widest)
    }
    expect(props.every((root) => root.attachment >= 0.04)).toBe(true)
    // The load path is through the air, so the solver must not flatten them
    // onto the soil the way it holds an ordinary radial root.
    expect(props.every((root) => root.aerial)).toBe(true)
    for (const root of props) {
      const source = root.spine[0]!.position
      const foot = root.spine.at(-1)!.position
      const drop = source.y - foot.y
      const reach = Math.hypot(foot.x - source.x, foot.z - source.z)
      expect(drop).toBeGreaterThan(0.5)
      // Steeper than forty-five degrees: a stilt stands the tree up rather than
      // sprawling away from it.
      expect(drop).toBeGreaterThan(reach)
      // And it ends below grade, so no cap disc is left lying on the substrate.
      expect(foot.y).toBeLessThan(0)
    }
  })

  it('braids strangler-fig roots around its fused host-like boles', () => {
    const tree = graph('strangler-fig')
    const wraps = tree.parts.filter((part) => part.id.startsWith('wrapping-root-'))
    const fusedAxes = tree.parts.filter((part) => part.id.startsWith('stem-'))

    expect(wraps.length).toBeGreaterThanOrEqual(7)
    expect(fusedAxes.length).toBeGreaterThanOrEqual(2)
    expect(wraps.every((root) => root.spine[0]!.position.y >
      root.spine.at(-1)!.position.y)).toBe(true)
  })

  it('makes acacia wider than tall with a high, flattened crown', () => {
    const tree = graph('umbrella-acacia')
    const width = tree.bounds.max.x - tree.bounds.min.x
    const depth = tree.bounds.max.z - tree.bounds.min.z
    const height = tree.bounds.max.y - tree.bounds.min.y

    expect(Math.max(width, depth)).toBeGreaterThan(height)
  })

  it('separates tall rainbow eucalyptus from sparse, twisting gum habit', () => {
    const rainbow = graph('rainbow-eucalyptus')
    const gum = graph('gum-eucalyptus')

    expect(rainbow.bounds.max.y).toBeGreaterThan(gum.bounds.max.y * 1.6)
    expect(gum.parts.filter((part) => part.id.startsWith('stem-')).length)
      .toBeGreaterThan(1)
  })

  it('gives sequoia heavy irregular tiers and Norfolk pine clean regular tiers', () => {
    const sequoia = graph('giant-sequoia')
    const norfolk = graph('norfolk-island-pine')
    const sequoiaTiers = sequoia.parts.filter((part) => /^whorl-\d+-\d+$/.test(part.id))
    const norfolkTiers = norfolk.parts.filter((part) => /^whorl-\d+-\d+$/.test(part.id))

    expect(sequoiaTiers.length).toBeGreaterThan(norfolkTiers.length)
    expect(sequoia.parts.some((part) => part.id.includes('-drop-'))).toBe(true)
    expect(norfolk.parts.some((part) => part.id.includes('-drop-'))).toBe(false)
  })

  it('keeps live oak broad, beech tall, and birch multi-stemmed and light', () => {
    const liveOak = graph('live-oak')
    const beech = graph('european-beech')
    const birch = graph('silver-birch')
    const liveWidth = liveOak.bounds.max.x - liveOak.bounds.min.x

    expect(liveWidth).toBeGreaterThan(liveOak.bounds.max.y)
    expect(beech.bounds.max.y).toBeGreaterThan(liveOak.bounds.max.y)
    expect(birch.parts.filter((part) => part.id.startsWith('stem-')).length)
      .toBeGreaterThan(1)
  })

  it('separates Lebanon cedar platforms from tortured Japanese black pine', () => {
    const cedar = graph('cedar-of-lebanon')
    const blackPine = graph('japanese-black-pine')

    expect(cedar.bounds.max.x - cedar.bounds.min.x).toBeGreaterThan(18)
    expect(blackPine.parts.some((part) => part.id.startsWith('dead-stub-'))).toBe(true)
  })
})

function distanceToSpine(
  point: { x: number; y: number; z: number },
  spine: readonly { position: { x: number; y: number; z: number } }[],
): number {
  let nearest = Infinity
  for (let index = 0; index < spine.length - 1; index += 1) {
    const a = spine[index]!.position
    const b = spine[index + 1]!.position
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const ap = { x: point.x - a.x, y: point.y - a.y, z: point.z - a.z }
    const lengthSquared = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z
    const t = Math.max(0, Math.min(1, (
      ap.x * ab.x + ap.y * ab.y + ap.z * ab.z
    ) / Math.max(1e-8, lengthSquared)))
    nearest = Math.min(nearest, Math.hypot(
      point.x - (a.x + ab.x * t),
      point.y - (a.y + ab.y * t),
      point.z - (a.z + ab.z * t),
    ))
  }
  return nearest
}

function junctionTangentCosine(
  parent: readonly { position: { x: number; y: number; z: number } }[],
  child: readonly { position: { x: number; y: number; z: number } }[],
): number {
  const parentA = parent.at(-2)!.position
  const parentB = parent.at(-1)!.position
  const childA = child[0]!.position
  const childB = child[1]!.position
  const parentDirection = {
    x: parentB.x - parentA.x,
    y: parentB.y - parentA.y,
    z: parentB.z - parentA.z,
  }
  const childDirection = {
    x: childB.x - childA.x,
    y: childB.y - childA.y,
    z: childB.z - childA.z,
  }
  const parentLength = Math.hypot(
    parentDirection.x,
    parentDirection.y,
    parentDirection.z,
  )
  const childLength = Math.hypot(
    childDirection.x,
    childDirection.y,
    childDirection.z,
  )
  return (
    parentDirection.x * childDirection.x +
    parentDirection.y * childDirection.y +
    parentDirection.z * childDirection.z
  ) / Math.max(1e-8, parentLength * childLength)
}
