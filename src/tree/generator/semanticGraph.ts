import {
  add,
  clamp,
  cross,
  emptyBounds,
  groundHeightAt,
  includeInBounds,
  length,
  lerp,
  lerpNumber,
  multiply,
  normalize,
  smoothstep,
  subtract,
  TreeRandom,
  vec3,
} from './math'
import {
  normalizeTreeParameters,
  type FoliageCluster,
  type SemanticTreeGraph,
  type SemanticTreePart,
  type TreeCrossSection,
  type TreeEnvironment,
  type TreeParameters,
  type TreeSpineSample,
  type TreeVec3,
} from './types'
import { resolveTreeSpace } from './spatialSolver'
import { deriveTreeHabit, type LostLimb, type TreeHabit } from './treeHabit'
import {
  buildCrownEnvelope,
  chainsFrom,
  growCrown,
  lobePhases,
  perpendicular,
  type CrownEnvelope,
  type CrownLobe,
  type GrowthChain,
  type GrowthNode,
  type GrowthSeed,
  type GrowthSettings,
} from './crownArchitecture'
import { speciesArchitecture, type SpeciesArchitecture } from './speciesArchitecture'

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/**
 * Builds the cached, editable representation. Geometry compilation deliberately
 * happens later so artists can change hierarchy and spines without losing the
 * semantic relationships that produced them.
 */
export function generateSemanticTree(
  input: Partial<TreeParameters> | undefined,
  environment: TreeEnvironment,
): SemanticTreeGraph {
  const parameters = normalizeTreeParameters(input)
  const random = new TreeRandom(parameters.seed)
  const architecture = speciesArchitecture(parameters)
  const habit = deriveTreeHabit(parameters)
  const parts: SemanticTreePart[] = []

  const trunk = createTrunk(parameters, architecture, habit, random)
  parts.push(trunk)

  // A co-dominant tree is not one bole with two big branches: the *trunk*
  // divides, and both halves carry bark, girth and their own crown from there
  // up. Modelling it as branches left every tree in the set standing on the
  // same single column, which is most of why they all read as the same tree.
  const stems = createCodominantStems(parameters, habit, random, trunk)
  parts.push(...stems)
  for (const stem of stems) connect(trunk, stem, stem.junctionType === 'continuation')

  const boles = stems.length > 0 ? stems : [trunk]
  const crown = growCrownParts(parameters, architecture, habit, random, trunk, boles)
  parts.push(...crown.parts)

  // Stubs of the limbs this individual actually lost, at the scars the trunk
  // already swelled around, rather than a fixed quota at arbitrary places.
  for (const [index, wound] of habit.lostLimbs.entries()) {
    const stub = createDeadStub(parameters, random, trunk, index, wound)
    parts.push(stub)
    connect(trunk, stub, false)
  }
  // Stag head: the bare spars of the old crown standing clear above the living
  // one. On a retrenching veteran this is the silhouette — a dense low mass
  // with dead antlers over it — and it is the single most identifiable
  // ancient-oak profile there is.
  for (let index = 0; index < habit.deadSparCount; index += 1) {
    const carrier = crown.branches
      .filter((branch) => branch.branchOrder <= 1)
      .sort((a, b) => b.spine.at(-1)!.position.y - a.spine.at(-1)!.position.y)
    const parent = carrier[index % Math.max(1, carrier.length)]
    if (!parent) break
    const spar = createDeadSpar(parameters, habit, random, parent, index)
    parts.push(spar)
    connect(parent, spar, false)
  }

  const structuralRoots: SemanticTreePart[] = []
  for (let index = 0; index < parameters.rootCount; index += 1) {
    const root = createStructuralRoot(
      parameters,
      habit,
      environment,
      random,
      index,
      trunk,
      crown.branches,
    )
    parts.push(root)
    structuralRoots.push(root)
    connect(trunk, root, false)
  }
  for (const [rootIndex, root] of structuralRoots.entries()) {
    const forkCount = rootIndex % 3 === 0 ? 2 : 1
    for (let forkIndex = 0; forkIndex < forkCount; forkIndex += 1) {
      const fork = createRootFork(
        parameters,
        environment,
        random,
        root,
        rootIndex,
        forkIndex,
        forkCount,
      )
      parts.push(fork)
      connect(root, fork, false)
    }
  }

  raiseButtresses(parts, trunk, habit, parameters)
  buryRootEnds(parts, environment)
  applyLoadSwelling(parts)
  solveRadiusInheritance(parts)
  const graph: SemanticTreeGraph = {
    seed: parameters.seed,
    parts,
    contacts: [],
    foliageClusters: [],
    bounds: emptyBounds(),
  }
  resolveTreeSpace(graph, environment, parameters)
  graph.foliageClusters = createFoliageClusters(
    crown.nodes,
    parameters,
    architecture,
    random,
  )
  graph.bounds = graphBounds(graph)
  return graph
}

function createTrunk(
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
  habit: TreeHabit,
  random: TreeRandom,
): SemanticTreePart {
  // A snapped veteran's bole is what is *left* of it, so the sweep is short and
  // the break is where the crown gets rebuilt from. A divided one stops at its
  // union, because everything above that belongs to the stems — leaving the
  // bole at full height and stacking the stems on top hid the whole division
  // inside the crown, which is the one thing it exists to show.
  const height = parameters.height * architecture.boleFraction * habit.snapHeight *
    (habit.forkHeight > 0 ? clamp(habit.forkHeight, 0.34, 0.8) : 1)
  const sampleCount = parameters.species === 'ancient-oak' ? 22 : 18
  const pine = parameters.species === 'windswept-pine'
  const ancient = parameters.species === 'ancient-oak'
  const leanX = Math.cos(habit.leanAzimuth)
  const leanZ = Math.sin(habit.leanAzimuth)
  // The bole's meander runs in a plane of its own, not in the lean's, so a
  // leaning sinuous trunk corkscrews the way a real one does instead of just
  // bending harder in the same direction.
  const meanderAzimuth = habit.leanAzimuth + random.range(0.8, 2.3)
  const meanderX = Math.cos(meanderAzimuth)
  const meanderZ = Math.sin(meanderAzimuth)
  const meanderPhase = random.range(0, Math.PI * 2)
  const buriedButt = parameters.trunkRadius * 0.55
  const spine: TreeSpineSample[] = []
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / (sampleCount - 1)
    const oldWood = parameters.age * smoothstep(0, 0.55, 1 - t)
    // Lean accumulates with height rather than tilting the whole column off its
    // base, because a tree that leans grew that way rather than being pushed.
    const leanOffset = t * t * height * Math.tan(habit.lean)
    const meander = Math.sin(t * Math.PI * habit.sinuosityTurns * 2 + meanderPhase) *
      habit.sinuosity * parameters.trunkRadius *
      // Almost none at the butt — the base of a bole is anchored — building
      // through the middle and easing off at the top.
      smoothstep(0, 0.35, t) * (1 - t * 0.25)
    const position = vec3(
      leanX * leanOffset + meanderX * meander,
      // The butt starts below the soil. A trunk that begins exactly at ground
      // level shows its own end cap as a hard flat disc cut across the base,
      // and no amount of root work hides a straight line through the flare.
      lerpNumber(-buriedButt, height, t),
      leanZ * leanOffset + meanderZ * meander,
    )
    const taper = Math.pow(1 - t, ancient ? 0.62 : 0.72)
    // Two flares superposed: a wide, shallow one for the whole butt and a tight
    // one right at the ground where the buttress roots merge in. One smooth
    // curve gives the traffic-cone base that reads as procedural immediately.
    // Deliberately modest. A big smooth flare swallows the buttress roots
    // whole, so the base reads as one moulded elephant foot with nothing
    // emerging from it; the roots are supposed to carry that silhouette.
    const baseFlare = 1 +
      smoothstep(0.34, 0, t) * (ancient ? 0.16 + parameters.age * 0.12 : 0.14) +
      smoothstep(0.09, 0, t) * (ancient ? 0.2 + parameters.age * 0.16 : 0.16)
    const terminalFraction = ancient ? 0.52 : pine ? 0.28 : 0.42
    // A broken bole does not taper to a point: it stays thick and stops.
    const snapSwell = habit.snapHeight < 1
      ? 1 + smoothstep(0.7, 1, t) * 0.22
      : 1
    // Wound wood piles up around old limb scars, so the bole is lumpy where it
    // has lost things rather than smoothly conical.
    let woundSwell = 1
    for (const wound of habit.lostLimbs) {
      woundSwell += smoothstep(0.16, 0, Math.abs(t - wound.height)) *
        wound.scale * 0.28
    }
    const radius = parameters.trunkRadius *
      (terminalFraction + taper * (1 - terminalFraction)) *
      baseFlare * snapSwell * woundSwell
    spine.push({
      position,
      radius,
      burialDepth: 0,
      crossSection: {
        radiusX: radius * (1 + oldWood * 0.08),
        radiusZ: radius * (1 - oldWood * 0.045),
        // Spiral grain. A veteran's flutes wind around the bole over its
        // length rather than running as straight columns.
        rotation: t * habit.twist,
        // Buttressing, not fluting. A high lobe count run up the whole bole
        // turned the trunk into a fluted column; real swelling is a handful of
        // broad ribs that die out a metre or two above the roots.
        lobeCount: clamp(Math.round(parameters.rootCount * 0.6), 3, 5),
        lobeStrength: smoothstep(0.42, 0, t) * habit.fluting *
          (0.06 + parameters.age * (ancient ? 0.2 : 0.12)),
      },
    })
  }
  return {
    id: 'trunk',
    type: 'trunk',
    children: [],
    branchOrder: 0,
    age: parameters.age,
    vigor: 1,
    dominance: 1,
    attachment: 0,
    junctionType: 'root-flare',
    spine,
  }
}

/**
 * Divides the bole into competing stems, when this individual's habit says it
 * never resolved a leader.
 *
 * Each stem is trunk-like in its own right — trunk girth, trunk taper, its own
 * lean and meander — rather than a branch that happens to be thick. That
 * matters because the two are read completely differently: a branch leaves a
 * trunk at an angle and tapers away from it, while co-dominant stems rise
 * together out of a shared union with a seam of included bark between them, and
 * neither one looks like the parent of the other.
 */
function createCodominantStems(
  parameters: TreeParameters,
  habit: TreeHabit,
  random: TreeRandom,
  trunk: SemanticTreePart,
): SemanticTreePart[] {
  if (habit.forkHeight <= 0) return []
  const union = trunk.spine.at(-1)!
  const boleTop = union.position.y
  // Whatever the bole did not use, the stems carry between them.
  const remaining = Math.max(
    parameters.height * 0.2,
    parameters.height * habit.snapHeight - boleTop,
  )
  const azimuth = random.range(0, Math.PI * 2)
  const stems: SemanticTreePart[] = []
  const shares = [habit.forkBalance, 1 - habit.forkBalance]

  for (const [index, share] of shares.entries()) {
    const heading = azimuth + index * Math.PI + random.range(-0.35, 0.35)
    const outward = vec3(Math.cos(heading), 0, Math.sin(heading))
    // The heavier stem stands nearer to vertical and the lighter one leans off
    // it, which is how the pair resolve their shared load.
    const splay = lerpNumber(0.34, 0.14, share) * random.range(0.75, 1.3)
    const length = remaining * lerpNumber(0.8, 1.05, share)
    const sampleCount = 14
    // Area conservation across the union: two stems of a given girth need a
    // bole below them thick enough to carry both.
    const baseRadius = union.radius * Math.sqrt(share) * 0.96
    const phase = random.range(0, Math.PI * 2)
    const meanderSide = normalize(cross(outward, vec3(0, 1, 0)), vec3(1, 0, 0))
    const spine: TreeSpineSample[] = []
    for (let step = 0; step < sampleCount; step += 1) {
      const t = step / (sampleCount - 1)
      const meander = Math.sin(t * Math.PI * 1.6 + phase) *
        baseRadius * habit.sinuosity * 0.9 * smoothstep(0, 0.3, t)
      const position = add(
        union.position,
        add(
          add(
            multiply(outward, length * splay * t),
            vec3(0, length * t, 0),
          ),
          multiply(meanderSide, meander),
        ),
      )
      // Swollen at the union and tapering hard: the buttress of wood a fork
      // grows to hold itself together is one of its most recognisable features.
      const unionSwell = 1 + smoothstep(0.22, 0, t) * (0.28 + parameters.age * 0.22)
      const radius = Math.max(
        0.05,
        baseRadius * (0.42 + Math.pow(1 - t, 0.7) * 0.58) * unionSwell,
      )
      spine.push({
        position,
        radius,
        burialDepth: 0,
        crossSection: {
          // Flattened across the fork. Co-dominant stems press against each
          // other as they thicken, so neither is round where they meet.
          radiusX: radius * lerpNumber(1, 0.82, smoothstep(0.35, 0, t)),
          radiusZ: radius * lerpNumber(1, 1.16, smoothstep(0.35, 0, t)),
          rotation: heading + t * habit.twist * 0.4,
          lobeCount: 3,
          lobeStrength: smoothstep(0.3, 0, t) * parameters.age * 0.1,
        },
      })
    }
    stems.push({
      id: `stem-${index + 1}`,
      type: 'trunk',
      parentId: trunk.id,
      children: [],
      branchOrder: 0,
      age: parameters.age * random.range(0.9, 1),
      vigor: 0.8 + share * 0.2,
      dominance: share,
      attachment: 1,
      // One stem carries the bole's flow through; the other is the division.
      junctionType: index === 0 ? 'continuation' : 'bifurcation',
      spine,
    })
  }
  return stems
}

function growCrownParts(
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
  habit: TreeHabit,
  random: TreeRandom,
  trunk: SemanticTreePart,
  /** The members the crown grows off: one bole, or a divided pair of stems. */
  boles: readonly SemanticTreePart[],
): {
  parts: SemanticTreePart[]
  branches: SemanticTreePart[]
  nodes: GrowthNode[]
  envelope: CrownEnvelope
} {
  const envelope = buildCrownEnvelope(
    crownLobesFor(parameters, architecture, habit, trunk, boles, random),
  )

  const seeds: GrowthSeed[] = []
  const seedAttachments: number[] = []
  // Which member each seed leaves. On a divided bole the scaffolds belong to
  // whichever stem they grew off, not to the shared stump below the union.
  const seedParents: SemanticTreePart[] = []

  // Every bole carries its own axis into the crown. On a single-stemmed tree
  // that is the leader; on a divided one both stems have one, and neither
  // yielding to the other is exactly what co-dominance means.
  for (const bole of boles) {
    const top = bole.spine.at(-1)!
    const azimuth = random.range(0, Math.PI * 2)
    seeds.push({
      position: { ...top.position },
      direction: normalize(vec3(
        Math.cos(azimuth) * random.range(0.05, 0.3),
        1,
        Math.sin(azimuth) * random.range(0.05, 0.3),
      )),
      attachment: 1,
      availableRadius: top.radius * 0.94,
    })
    seedAttachments.push(1)
    seedParents.push(bole)
  }

  const scaffoldCount = Math.max(
    2,
    // A snapped bole rebuilds its crown from a rack of shoots off the break,
    // so it carries more, steeper leaders than an intact tree of the same size.
    architecture.scaffoldCount + (habit.boleForm === 'snapped' ? 2 : 0),
  )
  // Golden-angle phyllotaxy with real jitter: evenly spaced scaffolds around a
  // bole is the single most recognisable procedural tell.
  const azimuthOffset = random.range(0, Math.PI * 2)
  for (let index = 0; index < scaffoldCount; index += 1) {
    // Dealt alternately between the stems, so a divided bole ends up with two
    // competing crowns rather than one stem carrying everything.
    const bole = boles[index % boles.length]!
    const along = clamp(
      lerpNumber(
        architecture.lowestScaffold,
        0.97,
        scaffoldCount === 1 ? 0.5 : index / (scaffoldCount - 1),
      ) + random.range(-0.045, 0.045),
      0.16,
      0.985,
    )
    const source = samplePart(bole, along)
    const azimuth = azimuthOffset + index * GOLDEN_ANGLE + random.range(-0.5, 0.5)
    const outward = vec3(Math.cos(azimuth), 0, Math.sin(azimuth))
    const rise = lerpNumber(
      architecture.scaffoldRise[0],
      architecture.scaffoldRise[1],
      random.unit() * random.unit(),
    )
    const tangent = tangentAt(bole, along)
    seeds.push({
      position: add(source.position, multiply(outward, source.radius * 0.72)),
      direction: normalize(add(
        add(multiply(outward, 1), vec3(0, rise, 0)),
        multiply(tangent, architecture.scaffoldFollow),
      )),
      attachment: along,
      availableRadius: source.radius * random.range(0.44, 0.66),
    })
    seedAttachments.push(along)
    seedParents.push(bole)
  }

  // Reiteration. When a veteran loses a limb it does not simply carry a hole:
  // dormant buds around the wound break into a sheaf of near-vertical shoots
  // that rebuild a small crown of their own in that gap. A rack of steep,
  // parallel stems standing up out of an old scar is one of the most
  // recognisable things about an ancient oak, and it cannot be produced by any
  // setting of a symmetric branching plan — the whole point is that it is a
  // local response to damage at one specific place on one specific tree.
  for (const wound of habit.lostLimbs) {
    if (!wound.reiterated) continue
    const source = samplePart(trunk, clamp(wound.height, 0.15, 0.97))
    const shoots = 2 + Math.floor(random.unit() * 3)
    for (let index = 0; index < shoots; index += 1) {
      const azimuth = wound.azimuth + random.range(-0.55, 0.55)
      const outward = vec3(Math.cos(azimuth), 0, Math.sin(azimuth))
      seeds.push({
        position: add(source.position, multiply(outward, source.radius * 0.86)),
        // Nearly straight up. Epicormic growth is unbranched and vertical for
        // years before it starts behaving like a limb.
        direction: normalize(add(
          multiply(outward, random.range(0.16, 0.42)),
          vec3(0, random.range(2.4, 4), 0),
        )),
        attachment: clamp(wound.height, 0.15, 0.97),
        availableRadius: source.radius * wound.scale * random.range(0.2, 0.34),
      })
      seedAttachments.push(clamp(wound.height, 0.15, 0.97))
      seedParents.push(trunk)
    }
  }

  const segmentLength = Math.max(0.22, parameters.crownRadius * architecture.segmentFraction)
  const settings: GrowthSettings = {
    segmentLength,
    influenceRadius: segmentLength * 5.6,
    killRadius: segmentLength * 1.85,
    attractorCount: Math.round(
      architecture.attractorCount * lerpNumber(0.55, 1.15, parameters.foliageDensity),
    ),
    upTropism: architecture.upTropism,
    sag: architecture.sag,
    axialPersistence: architecture.axialPersistence,
    wander: architecture.wander,
    maximumIterations: 280,
    shellBias: architecture.shellBias,
    tipRadius: 0.009,
  }
  const nodes = growCrown(seeds, envelope, settings, random)
  const chains = chainsFrom(nodes, seeds.length)

  // A chain is worth sweeping only if its thickest end clears the tip radius.
  // Anything below it is twig the leaf cards already draw.
  const chainForNode = new Map<number, number>()
  const keptChains: GrowthChain[] = []
  for (const chain of chains) {
    if (nodes[chain.root]!.radius < architecture.meshedTipRadius) continue
    const index = keptChains.length
    keptChains.push(chain)
    // A forked chain's first node is the fork itself, which belongs to the
    // parent member. Claiming it here would make grandchildren attach to the
    // wrong chain.
    for (const node of chain.nodes) {
      if (node === chain.nodes[0] && chain.nodes[0] !== chain.root) continue
      chainForNode.set(node, index)
    }
  }

  const parts: SemanticTreePart[] = []
  const branches: SemanticTreePart[] = []
  // Exactly one chain is the bole's own axis carried into the crown: the one
  // that *owns* seed 0. Chains merely passing through node 0 — the forks that
  // leave the apex — are ordinary limbs.
  const partIds = keptChains.map((chain, index) =>
    chain.root === 0 ? 'leader' : `limb-${index}`,
  )
  for (const [index, chain] of keptChains.entries()) {
    const isSeedChain = chain.root < seeds.length
    let parentId = isSeedChain ? seedParents[chain.root]!.id : trunk.id
    let attachment = isSeedChain ? seedAttachments[chain.root]! : 0
    if (!isSeedChain) {
      // nodes[0] is the shared fork node, so the parent member is the chain
      // that owns *it*, not the one that owns this chain's second node.
      const parentNode = chain.nodes[0]!
      const parentChain = chainForNode.get(parentNode)
      if (parentChain === undefined) continue
      parentId = partIds[parentChain]!
      const parentNodes = keptChains[parentChain]!.nodes
      attachment = clamp(
        parentNodes.indexOf(parentNode) / Math.max(1, parentNodes.length - 1),
        0.02,
        0.99,
      )
    }
    const part = chainToPart(
      partIds[index]!,
      parentId,
      attachment,
      chain.nodes,
      nodes,
      parameters,
      architecture,
      random,
      chain.root === 0,
    )
    parts.push(part)
    branches.push(part)
  }

  const byId = new Map<string, SemanticTreePart>(parts.map((part) => [part.id, part]))
  byId.set(trunk.id, trunk)
  for (const part of parts) {
    const parent = byId.get(part.parentId!)
    if (!parent) continue
    parent.children.push(part.id)
    if (part.junctionType === 'continuation') parent.continuationChildId = part.id
  }
  return { parts, branches, nodes, envelope }
}

/**
 * The crown units this individual carries.
 *
 * One unit is a young tree, or an old one that never lost anything. Everything
 * past that is an accumulation: a mass over each surviving scaffold, a pair of
 * them over a co-dominant fork, a small new one over every reiteration that
 * answered a lost limb, and the whole set pulled to the heavy side. That
 * accumulation is why an old oak reads as several trees fused and a young one
 * reads as a single dome — and it is the difference no slider reaches, because
 * a single envelope driven harder is still one envelope.
 */
function crownLobesFor(
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
  habit: TreeHabit,
  trunk: SemanticTreePart,
  boles: readonly SemanticTreePart[],
  random: TreeRandom,
): CrownLobe[] {
  // A retrenched veteran's living crown has withdrawn: the dead spars stand
  // above it, but the leaves stop lower than the tree's full height.
  const top = parameters.height * (1 - habit.retrenchment)
  const base = parameters.height * architecture.crownBaseFraction * habit.snapHeight
  const radius = parameters.crownRadius
  const lobes: CrownLobe[] = []
  let salt = parameters.seed

  const push = (
    centreX: number,
    centreZ: number,
    lobeBase: number,
    lobeTop: number,
    lobeRadius: number,
    broadnessScale = 1,
  ) => {
    salt = (salt * 1664525 + 1013904223) >>> 0
    lobes.push({
      centreX,
      centreZ,
      baseY: lobeBase,
      topY: lobeTop,
      radius: lobeRadius,
      broadness: clamp(architecture.broadness * broadnessScale, 0.16, 0.86),
      profileExponent: architecture.profileExponent * random.range(0.86, 1.18),
      lobeAmplitude: architecture.lobeAmplitude * random.range(0.8, 1.3),
      ripples: architecture.lobeCount + Math.floor(random.unit() * 3),
      phases: lobePhases(salt),
    })
  }

  const biasX = Math.cos(habit.crownBiasAzimuth)
  const biasZ = Math.sin(habit.crownBiasAzimuth)
  const pull = radius * habit.crownBias

  if (boles.length > 1) {
    // A crown over each stem, centred where that stem actually ends rather than
    // at a guessed offset. Their overlap in the middle is what keeps the pair
    // reading as one tree instead of two planted together.
    //
    // The base is lifted clear of the union so a good stretch of both stems
    // stands bare below the foliage. Without that the crowns close over the
    // fork and the tree is indistinguishable from a single-stemmed one.
    const unionY = trunk.spine.at(-1)!.position.y
    const clearance = unionY + (top - unionY) * random.range(0.3, 0.46)
    for (const bole of boles) {
      const tip = bole.spine.at(-1)!.position
      push(
        tip.x + biasX * pull * 0.4,
        tip.z + biasZ * pull * 0.4,
        Math.max(base, clearance),
        top * random.range(0.92, 1.02),
        radius * (0.6 + bole.dominance * 0.55),
      )
    }
  } else {
    push(biasX * pull, biasZ * pull, base, top, radius)
  }

  // A mass over each of the biggest surviving scaffolds. These overlap the main
  // crown heavily; what they add is a lumpy, multi-centred boundary in place of
  // one smooth dome.
  const satellites = habit.crownForm === 'full'
    ? 1 + Math.floor(random.unit() * 2)
    : 2 + Math.floor(random.unit() * 3)
  for (let index = 0; index < satellites; index += 1) {
    const azimuth = random.range(0, Math.PI * 2)
    const distance = radius * random.range(0.3, 0.62)
    const scale = random.range(0.4, 0.68)
    push(
      Math.cos(azimuth) * distance + biasX * pull,
      Math.sin(azimuth) * distance + biasZ * pull,
      base + (top - base) * random.range(0.05, 0.34),
      top * random.range(0.72, 0.99),
      radius * scale,
      random.range(0.85, 1.2),
    )
  }

  // A small crown over every reiteration. These are the ones that read from a
  // distance: tight vertical tufts standing off the side of the old mass where
  // a limb used to be.
  const boleHeight = trunk.spine.at(-1)!.position.y
  for (const wound of habit.lostLimbs) {
    if (!wound.reiterated) continue
    const woundY = boleHeight * wound.height
    const distance = radius * random.range(0.24, 0.46)
    push(
      Math.cos(wound.azimuth) * distance,
      Math.sin(wound.azimuth) * distance,
      Math.max(base * 0.7, woundY + parameters.height * 0.04),
      Math.min(top, woundY + parameters.height * random.range(0.22, 0.42)),
      radius * random.range(0.18, 0.32),
      random.range(0.5, 0.8),
    )
  }

  return lobes
}

function chainToPart(
  id: string,
  parentId: string,
  attachment: number,
  chain: readonly number[],
  nodes: readonly GrowthNode[],
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
  random: TreeRandom,
  continuation: boolean,
): SemanticTreePart {
  // chain[0] is the fork node, which belongs to the parent member. The member's
  // own identity — its order and its girth — comes from the first node past it.
  const own = nodes[chain[Math.min(1, chain.length - 1)]!]!
  const order = Math.min(4, own.order + (parentId === 'trunk' ? 1 : 0))
  const phase = random.range(0, Math.PI * 2)
  // Gnarl belongs on the heavy old members. Applying it uniformly makes twigs
  // wobble like wet noodles and hides the sinuous character of the limbs.
  const gnarlWeight = parameters.gnarl * Math.max(0, 1 - order * 0.3)
  // A forked chain starts at the fork node so there is no gap between the limb
  // and the member it leaves. But the fork node sits on the *parent's* centre
  // line, and a ring swept there is buried inside the parent: the collar then
  // projects several rings onto nearly the same surface patch and welds them
  // into non-manifold edges. Sliding that first station out to the parent's
  // surface keeps the limb visually attached and gives the collar something
  // with real length to work with.
  const forkOffset = parentId === 'trunk' || chain.length < 2
    ? 0
    : nodes[chain[0]!]!.radius * 0.82
  const spine: TreeSpineSample[] = []
  for (const [index, nodeIndex] of chain.entries()) {
    const node = nodes[nodeIndex]!
    const t = index / Math.max(1, chain.length - 1)
    const basePosition = index === 0 && forkOffset > 0
      ? add(
          node.position,
          multiply(
            normalize(
              subtract(nodes[chain[1]!]!.position, node.position),
              node.direction,
            ),
            Math.min(
              forkOffset,
              length(subtract(nodes[chain[1]!]!.position, node.position)) * 0.7,
            ),
          ),
        )
      : node.position
    const side = perpendicular(node.direction)
    const across = cross(node.direction, side)
    const swing = Math.sin(t * Math.PI * 2.1 + phase) * 0.68 +
      Math.sin(t * Math.PI * 4.7 + phase * 1.7) * 0.32
    const twist = Math.sin(t * Math.PI * 3.3 + phase * 0.7)
    const amplitude = node.radius * gnarlWeight * 1.35
    const position = add(
      basePosition,
      add(multiply(side, swing * amplitude), multiply(across, twist * amplitude * 0.6)),
    )
    const radius = Math.max(0.008, node.radius)
    spine.push({
      position,
      radius,
      burialDepth: 0,
      crossSection: branchCrossSection(radius, t, parameters, random, order * 7 + index),
    })
  }
  const thickest = spine[Math.min(1, spine.length - 1)]!.radius
  return {
    id,
    type: thickest < architecture.meshedTipRadius * 2.6 ? 'twig' : 'branch',
    parentId,
    children: [],
    branchOrder: order,
    age: parameters.age * clamp(1 - order * 0.17, 0.2, 1),
    vigor: clamp(1 - order * 0.16 + random.signed() * 0.08, 0.2, 1),
    dominance: clamp(1 - order * 0.24, 0.06, 1),
    attachment,
    junctionType: continuation ? 'continuation' : order <= 1 ? 'bifurcation' : 'lateral',
    spine,
  }
}

function createDeadStub(
  parameters: TreeParameters,
  random: TreeRandom,
  parent: SemanticTreePart,
  index: number,
  wound: LostLimb,
): SemanticTreePart {
  const attachment = clamp(wound.height, 0.1, 0.95)
  const source = samplePart(parent, attachment)
  const parentTangent = tangentAt(parent, attachment)
  const outward = vec3(
    Math.cos(wound.azimuth),
    random.range(0.05, 0.38),
    Math.sin(wound.azimuth),
  )
  const direction = normalize(add(multiply(parentTangent, 0.24), outward))
  // Short and blunt. A shed limb tears off close to the collar; what is left
  // is a stub the tree is still trying to occlude, not a dead branch.
  const length = parameters.trunkRadius * wound.scale * random.range(1.6, 3.4)
  const sampleCount = 5
  const baseRadius = source.radius * wound.scale * random.range(0.7, 0.95)
  const spine: TreeSpineSample[] = []
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const t = sampleIndex / (sampleCount - 1)
    const crooked = vec3(
      Math.sin(t * Math.PI * 1.4 + index) * length * 0.045,
      -t * t * length * 0.06,
      Math.sin(t * Math.PI * 1.7 + index * 0.7) * length * 0.04,
    )
    const radius = baseRadius * lerpNumber(1, random.range(0.38, 0.56), t)
    spine.push({
      position: add(source.position, add(multiply(direction, length * t), crooked)),
      radius,
      burialDepth: 0,
      crossSection: branchCrossSection(radius, t, parameters, random, index + 71),
    })
  }
  return {
    id: `dead-stub-${index + 1}`,
    type: 'branch',
    parentId: parent.id,
    children: [],
    branchOrder: parent.branchOrder + 1,
    age: 1,
    vigor: 0,
    dominance: 0,
    attachment,
    junctionType: 'terminal',
    spine,
  }
}

/**
 * A structural root, from its buttress on the bole out to where it finally
 * commits to the soil.
 *
 * The important part is the vertical profile. A root modelled as one shallow
 * arch — up out of the ground, over, and down for good — is what the old
 * version drew, and it reads as a plastic fin stabbed into the terrain. A real
 * surface root of an old tree does the opposite: it breaks the soil several
 * times over its run, each surfacing shorter and lower than the last, with the
 * exposed sections worn smooth and pale and the buried sections vanishing
 * completely. That repeated in-and-out is most of what makes a veteran's base
 * read as something that has been sitting there for centuries.
 */
/**
 * A bare limb of the old crown, standing above the retrenched living one.
 *
 * Dead spars keep their diameter and end in a break rather than tapering to a
 * shoot, they carry no foliage, and they hold the height the tree used to
 * reach after the leaves have withdrawn below them.
 */
function createDeadSpar(
  parameters: TreeParameters,
  habit: TreeHabit,
  random: TreeRandom,
  parent: SemanticTreePart,
  index: number,
): SemanticTreePart {
  const attachment = random.range(0.45, 0.86)
  const source = samplePart(parent, attachment)
  const parentTangent = tangentAt(parent, attachment)
  const azimuth = index * GOLDEN_ANGLE + random.range(-0.5, 0.5)
  const outward = vec3(Math.cos(azimuth), 0, Math.sin(azimuth))
  const direction = normalize(add(
    add(multiply(parentTangent, 0.5), multiply(outward, random.range(0.3, 0.8))),
    vec3(0, random.range(0.9, 1.9), 0),
  ))
  const length = parameters.height * habit.retrenchment *
    random.range(0.7, 1.5) + parameters.crownRadius * 0.12
  const sampleCount = 7
  const baseRadius = source.radius * random.range(0.42, 0.66)
  const phase = random.range(0, Math.PI * 2)
  const side = normalize(cross(direction, vec3(0, 1, 0)), vec3(1, 0, 0))
  const spine: TreeSpineSample[] = []
  for (let index2 = 0; index2 < sampleCount; index2 += 1) {
    const t = index2 / (sampleCount - 1)
    const crook = multiply(
      side,
      Math.sin(t * Math.PI * 1.7 + phase) * length * 0.09,
    )
    const position = add(source.position, add(multiply(direction, length * t), crook))
    // Barely tapering, then a blunt end: dead wood snaps, it does not thin out.
    const radius = Math.max(0.03, baseRadius * (1 - t * 0.55))
    spine.push({
      position,
      radius,
      burialDepth: 0,
      crossSection: {
        radiusX: radius * 1.04,
        radiusZ: radius * 0.96,
        rotation: t * 0.6 + phase,
        lobeCount: 3,
        lobeStrength: 0.05,
      },
    })
  }
  return {
    id: `dead-spar-${index + 1}`,
    type: 'branch',
    parentId: parent.id,
    children: [],
    branchOrder: parent.branchOrder + 1,
    age: 1,
    vigor: 0,
    dominance: 0,
    attachment,
    junctionType: 'terminal',
    spine,
  }
}

function createStructuralRoot(
  parameters: TreeParameters,
  habit: TreeHabit,
  environment: TreeEnvironment,
  random: TreeRandom,
  index: number,
  trunk: SemanticTreePart,
  majorBranches: readonly SemanticTreePart[],
): SemanticTreePart {
  const primaryScaffolds = majorBranches.filter((branch) => branch.branchOrder <= 1)
  const loadBranch = primaryScaffolds[index % Math.max(1, primaryScaffolds.length)]
  const loadVector = loadBranch
    ? subtract(loadBranch.spine.at(-1)!.position, loadBranch.spine[0]!.position)
    : vec3(Math.cos(index * GOLDEN_ANGLE), 0, Math.sin(index * GOLDEN_ANGLE))
  const loadDirection = normalize(vec3(loadVector.x, 0, loadVector.z), vec3(1, 0, 0))
  const loadRadius = loadBranch?.spine[0]?.radius ?? parameters.trunkRadius * 0.5
  const loadSpan = Math.hypot(loadVector.x, loadVector.z)
  const structuralLoad = clamp(
    loadRadius / Math.max(0.001, parameters.trunkRadius) * 0.62 +
      loadSpan / Math.max(0.001, parameters.crownRadius) * 0.28,
    0.28,
    1,
  )
  // A leaning tree throws its biggest anchor roots out on the tension side,
  // which is the side it leans away from.
  const leanPull = Math.cos(
    Math.atan2(loadDirection.z, loadDirection.x) - habit.leanAzimuth - Math.PI,
  ) * habit.lean * 2.2
  const angle = index < primaryScaffolds.length
    ? Math.atan2(loadDirection.z, loadDirection.x) + random.range(-0.24, 0.24)
    : index * GOLDEN_ANGLE + parameters.seed * 0.00013 + random.range(-0.32, 0.32)
  const direction = normalize(vec3(Math.cos(angle), 0, Math.sin(angle)))
  const side = vec3(-direction.z, 0, direction.x)
  const length = parameters.rootSpread * random.range(0.58, 1.08) *
    lerpNumber(0.82, 1.18, structuralLoad) * (1 + Math.max(0, leanPull) * 0.5)
  const sampleCount = Math.max(14, Math.ceil(length / 0.5))
  // Buttressed roots climb the bole before they spread; sunken ones leave at
  // ground level. Where a root departs is most of what a base looks like — but
  // it has to be expressed in metres. As a *fraction of the bole* the same
  // number put a buttress two metres up a tall trunk, and the collar between it
  // and the ground came out as a huge flat sheet.
  const climbMetres = parameters.trunkRadius * (
    habit.rootForm === 'buttressed'
      ? random.range(0.45, 1.05) * (0.6 + habit.fluting)
      : habit.rootForm === 'stilted'
        ? random.range(0.3, 0.7)
        : random.range(0.05, 0.3)
  )
  const boleHeight = Math.max(0.5, trunk.spine.at(-1)!.position.y)
  const attachment = clamp(
    climbMetres / boleHeight + structuralLoad * 0.012,
    0.008,
    0.2,
  )
  const source = samplePart(trunk, attachment)
  const dominantButtress = index < primaryScaffolds.length
  // Sized against the bole's radius *where the root actually leaves it*, not
  // against the nominal trunk radius. A root that starts markedly thinner than
  // the flare it emerges from looks bolted on, which is most of why they read
  // as "suddenly starting" at the base.
  const flareRadius = Math.max(source.radius, parameters.trunkRadius)
  const baseRadius = flareRadius * (
    dominantButtress ? random.range(0.3, 0.42) : random.range(0.2, 0.29)
  ) * lerpNumber(0.86, 1.24, structuralLoad)

  const phase = random.range(0, Math.PI * 2)
  const wanderFrequency = random.range(1.15, 1.95)
  // Each root gets its own surfacing rhythm. Sharing one across the base makes
  // every root break the soil at the same radius, in a ring.
  const surfacings = Math.max(
    0,
    habit.rootSurfacings + (random.unit() < 0.4 ? 1 : 0) - (random.unit() < 0.3 ? 1 : 0),
  )
  // Phased so the first arch past the plate peaks soon after it, rather than
  // wherever the noise happened to land — a root whose one visible arch is out
  // past the drip line contributes nothing to the base a player stands at.
  const surfacePhase = surfacings > 0 ? Math.PI * 0.28 : 0
  const relief = habit.rootRelief * random.range(0.55, 1.35) *
    lerpNumber(0.5, 1.35, parameters.rootExposure)
  // How far the continuous surface plate runs before the arch rhythm begins.
  // Long on a buttressed or stilted individual, barely present on a sunken one.
  const plateEnd = habit.rootForm === 'sunken'
    ? random.range(0.06, 0.14)
    : random.range(0.24, 0.46) * lerpNumber(0.7, 1.25, clamp(habit.fluting, 0, 1))
  // Where along its run the root gives up on the surface for good.
  const commitAt = Math.max(plateEnd + 0.2, random.range(0.55, 0.9))

  const spine: TreeSpineSample[] = []
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const t = sampleIndex / (sampleCount - 1)
    const fan = multiply(direction, length * t)
    const wander = multiply(
      side,
      (Math.sin(t * Math.PI * wanderFrequency + phase) * 0.75 +
        Math.sin(t * Math.PI * wanderFrequency * 2.7 + phase * 1.6) * 0.25) *
        length * 0.1,
    )
    const horizontal = add(add(source.position, fan), wander)
    const radius = Math.max(0.05, baseRadius * Math.pow(1 - t * 0.94, 0.62))
    // Root cross sections run through three shapes over their length, and
    // getting the *order* right is what stops them reading as flat pressed
    // strips stuck on the terrain.
    //
    // At the bole it is a buttress: a tall, thin vertical fin, deeper than it
    // is wide, continuous with the trunk's own flare. Through the middle it
    // rolls over into the familiar strap, wider than deep, carrying the load.
    // By the tip it is round, because a root that has stopped buttressing
    // anything is just a pipe. The old version started flat immediately, so
    // every root left the trunk as a blade.
    const buttress = smoothstep(0.3, 0.02, t)
    // The strap runs as far as the plate does: while a root is still a surface
    // rib it is broad and shallow, and it only rounds off once it sinks.
    const strap = smoothstep(0.06, 0.34, t) * smoothstep(1, plateEnd + 0.3, t)
    // Kept mild. Pushed hard the strap becomes a flat plank with a visible
    // faceted edge, which is worse than a slightly too-round root.
    const radiusX = radius *
      lerpNumber(1, lerpNumber(1, 1.26, strap), 1 - buttress) *
      lerpNumber(1, 0.62, buttress)
    const radiusZ = radius *
      lerpNumber(1, lerpNumber(1, 0.86, strap), 1 - buttress) *
      lerpNumber(1, 1.65, buttress)
    const ground = groundHeightAt(
      horizontal.x,
      horizontal.z,
      environment.groundHeight,
      environment.slopeX,
      environment.slopeZ,
    )

    // Exposure comes in two parts, and the first one is what was missing.
    //
    // Nearest the bole the root is not an arch at all: it is a continuous
    // surface *plate*, the buttress rib carrying on across the ground for
    // several metres before it starts to sink. Modelling the whole run as a
    // rhythm of arches meant the rib ended in a cliff at the edge of the flare
    // and everything past it was either buried or a disconnected hump sitting
    // in the grass like debris.
    //
    // Past the plate the rhythm takes over: the root breaks the soil again a
    // couple of times, each surfacing lower than the last, and finally commits.
    const plate = smoothstep(plateEnd, 0.02, t)
    const remaining = smoothstep(commitAt + 0.16, commitAt - 0.3, t)
    const rhythm = surfacings > 0
      ? Math.pow(
          Math.max(0, Math.sin((t - plateEnd) * Math.PI * surfacings + surfacePhase)),
          1.4,
        ) * smoothstep(plateEnd - 0.08, plateEnd + 0.12, t)
      : 0
    // Arches get lower as the root runs out, the way load and taper dictate.
    const arch = Math.max(plate, rhythm * remaining * Math.pow(1 - t, 0.45))

    // Solved from where the root's *upper surface* sits relative to the soil,
    // not from where its centre line does. Driving the centre meant the visible
    // exposure depended on the radius at that station, so the wide strap
    // sections buried themselves exactly where the arch was supposed to be
    // showing — the roots never actually broke the surface at all.
    // The plate and the arches are lifted differently, and conflating them is
    // what left a cliff at the edge of the flare.
    //
    // A buttress plate is exposed *by definition* — it is the rib of the bole
    // lying on the ground — so its height comes from the root's own girth and
    // barely depends on the exposure setting. An arch further out is genuine
    // erosion, and that is what the setting governs. Driving both from the same
    // small number meant the plate emerged a few centimetres proud of the soil
    // while the rib it was supposed to continue stood a metre and a half tall.
    const plateLift = plate * radiusZ * (0.85 + relief * 0.8)
    const archLift = rhythm * remaining * Math.pow(1 - t, 0.45) *
      radiusZ * relief * 1.15
    // Anything barely proud of the soil is pushed under instead. A root that
    // clears the ground by a few centimetres over a short run does not read as
    // a root at all — it reads as a chip of bark lying in the grass.
    const exposure = Math.max(plateLift, archLift)
    const crownAboveGround = exposure *
      smoothstep(radiusZ * 0.18, radiusZ * 0.45, exposure)
    const buriedDepth = radiusZ *
      lerpNumber(0.6, 2.2, smoothstep(0.05, 0.75, t)) *
      (1 - arch)
    const dive = radiusZ * smoothstep(commitAt, 1, t) * 2.2
    const surfaceTop = ground + crownAboveGround - buriedDepth - dive
    const surfaceCenter = surfaceTop - radiusZ
    // The root leaves the bole and settles onto its surface profile over the
    // whole length of the plate, not in the first few centimetres. Completing
    // the handover early dropped the root off the side of the buttress rib in
    // one step — the cliff at the edge of the flare.
    const departure = smoothstep(0.02, plateEnd + 0.3, t)
    const centerY = lerpNumber(source.position.y, surfaceCenter, departure)
    spine.push({
      position: vec3(horizontal.x, centerY, horizontal.z),
      radius,
      burialDepth: ground - centerY,
      crossSection: {
        radiusX,
        radiusZ,
        rotation: Math.sin(t * 3 + phase) * 0.08,
        lobeCount: t < 0.3 ? 3 : 2,
        // The buttress rib where the root meets the bole.
        lobeStrength: smoothstep(0.34, 0, t) * parameters.age * 0.2 *
          (0.5 + habit.fluting),
      },
    })
  }
  return {
    id: `root-${index + 1}`,
    type: 'root',
    parentId: 'trunk',
    children: [],
    branchOrder: 1,
    age: parameters.age * random.range(0.82, 1),
    vigor: random.range(0.62, 0.94),
    dominance: random.range(0.45, 0.75),
    attachment,
    junctionType: 'root-flare',
    spine,
  }
}

function createRootFork(
  parameters: TreeParameters,
  environment: TreeEnvironment,
  random: TreeRandom,
  parent: SemanticTreePart,
  rootIndex: number,
  forkIndex: number,
  forkCount: number,
): SemanticTreePart {
  const attachment = 0.42 + ((forkIndex + 1) / (forkCount + 1)) * 0.28
  const source = samplePart(parent, attachment)
  const parentTangent = tangentAt(parent, attachment)
  const side = normalize(vec3(-parentTangent.z, 0, parentTangent.x))
  const direction = normalize(add(
    multiply(parentTangent, 0.48),
    multiply(side, (rootIndex + forkIndex) % 2 === 0 ? 0.88 : -0.88),
  ))
  const length = parameters.rootSpread * random.range(0.28, 0.48)
  const sampleCount = Math.max(6, Math.ceil(length / 0.7))
  const baseRadius = source.radius * random.range(0.42, 0.58)
  const phase = random.range(0, Math.PI * 2)
  const spine: TreeSpineSample[] = []
  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / (sampleCount - 1)
    const sideways = multiply(
      side,
      Math.sin(t * Math.PI * 1.4 + phase) * length * 0.08,
    )
    const horizontal = add(
      source.position,
      add(multiply(direction, length * t), sideways),
    )
    const radius = Math.max(0.035, baseRadius * Math.pow(1 - t, 0.72))
    const radiusX = radius * lerpNumber(1.16, 1.34, smoothstep(0.1, 0.75, t))
    const radiusZ = radius * lerpNumber(0.92, 0.7, smoothstep(0.18, 0.82, t))
    const ground = groundHeightAt(
      horizontal.x,
      horizontal.z,
      environment.groundHeight,
      environment.slopeX,
      environment.slopeZ,
    )
    // A whole radius of cover plus a margin. Burying a strap-shaped root by
    // barely its own half-thickness left its widest edges standing proud of the
    // soil as disconnected slivers — bark-coloured chips scattered around the
    // base with nothing joining them to the tree.
    const burialDepth = Math.max(radiusX, radiusZ) *
      (1.55 + smoothstep(0.28, 1, t) * 1.6)
    spine.push({
      position: vec3(horizontal.x, ground - burialDepth, horizontal.z),
      radius,
      burialDepth,
      crossSection: {
        radiusX,
        radiusZ,
        rotation: Math.sin(t * 2.2 + phase) * 0.05,
        lobeCount: 2,
        lobeStrength: parameters.age * smoothstep(0.4, 0, t) * 0.08,
      },
    })
  }
  return {
    id: `${parent.id}-fork-${forkIndex + 1}`,
    type: 'root',
    parentId: parent.id,
    children: [],
    branchOrder: 2,
    age: parent.age * random.range(0.62, 0.82),
    vigor: parent.vigor * random.range(0.52, 0.72),
    dominance: parent.dominance * 0.48,
    attachment,
    junctionType: 'lateral',
    spine,
  }
}

function branchCrossSection(
  radius: number,
  t: number,
  parameters: TreeParameters,
  random: TreeRandom,
  salt: number,
): TreeCrossSection {
  const ageCompression = parameters.age * (1 - t) * 0.1
  return {
    radiusX: radius * (1 + ageCompression + random.signed() * 0.018),
    radiusZ: radius * (1 - ageCompression * 0.5),
    rotation: t * (0.7 + parameters.gnarl * 1.4) + salt * 0.37,
    lobeCount: 3 + (salt % 3),
    lobeStrength: parameters.gnarl * (1 - t * 0.55) * 0.065,
  }
}

function samplePart(part: SemanticTreePart, t: number): TreeSpineSample {
  const scaled = clamp(t, 0, 1) * (part.spine.length - 1)
  const left = Math.floor(scaled)
  const right = Math.min(part.spine.length - 1, left + 1)
  const amount = scaled - left
  const a = part.spine[left]!
  const b = part.spine[right]!
  return {
    position: lerp(a.position, b.position, amount),
    radius: lerpNumber(a.radius, b.radius, amount),
    burialDepth: lerpNumber(a.burialDepth, b.burialDepth, amount),
    crossSection: {
      radiusX: lerpNumber(a.crossSection.radiusX, b.crossSection.radiusX, amount),
      radiusZ: lerpNumber(a.crossSection.radiusZ, b.crossSection.radiusZ, amount),
      rotation: lerpNumber(a.crossSection.rotation, b.crossSection.rotation, amount),
      lobeCount: amount < 0.5 ? a.crossSection.lobeCount : b.crossSection.lobeCount,
      lobeStrength: lerpNumber(
        a.crossSection.lobeStrength,
        b.crossSection.lobeStrength,
        amount,
      ),
    },
  }
}

function tangentAt(part: SemanticTreePart, t: number): TreeVec3 {
  const scaled = clamp(t, 0, 1) * (part.spine.length - 1)
  const left = Math.max(0, Math.floor(scaled) - 1)
  const right = Math.min(part.spine.length - 1, Math.ceil(scaled) + 1)
  return normalize(subtract(part.spine[right]!.position, part.spine[left]!.position))
}

function connect(
  parent: SemanticTreePart,
  child: SemanticTreePart,
  continuation: boolean,
): void {
  parent.children.push(child.id)
  if (continuation) parent.continuationChildId = child.id
}

/**
 * Grows the bole's base out along the roots that actually leave it.
 *
 * This is the join the whole base reads on. A round trunk with round roots
 * stuck to it can only ever look like pipes into a post, however good the
 * collar geometry is — the shapes disagree before they even meet. A real
 * buttressed oak has no boundary there at all: the bole is star-shaped in plan,
 * each rib runs out and *becomes* a root, and the valleys between the ribs run
 * right down to the soil.
 *
 * So the ribs are derived from the roots rather than authored separately. Each
 * root contributes a fin pointing the way it went, as wide as the root is
 * relative to the bole, fading out with height over a couple of metres. The
 * root's own first stations are then widened to match the rib they emerge from,
 * so the two surfaces are already the same shape where they meet.
 */
function raiseButtresses(
  parts: readonly SemanticTreePart[],
  trunk: SemanticTreePart,
  habit: TreeHabit,
  parameters: TreeParameters,
): void {
  const roots = parts.filter(
    (part) => part.type === 'root' && part.parentId === trunk.id,
  )
  if (roots.length === 0) return
  const boleHeight = Math.max(0.5, trunk.spine.at(-1)!.position.y)
  // Ribs die out well before the crown; on a heavily buttressed individual they
  // climb higher, which is most of what "buttressed" looks like from a distance.
  const reach = boleHeight * lerpNumber(0.16, 0.42, clamp(habit.fluting, 0, 1))

  interface RootFin {
    direction: TreeVec3
    strength: number
    width: number
  }
  const rootFins: RootFin[] = []
  for (const root of roots) {
    const start = root.spine[0]!
    const outward = normalize(
      subtract(samplePart(root, 0.28).position, trunk.spine[0]!.position),
      vec3(1, 0, 0),
    )
    const horizontal = normalize(vec3(outward.x, 0, outward.z), vec3(1, 0, 0))
    const share = clamp(
      start.crossSection.radiusX / Math.max(0.05, parameters.trunkRadius),
      0.12,
      0.95,
    )
    rootFins.push({
      direction: horizontal,
      // A major root's rib carries most of the bole's local girth; a minor one
      // barely registers. Scaling by the root's own share is what gives a base
      // two or three dominant plates rather than a uniform fluted collar.
      strength: share * lerpNumber(1.1, 2.2, clamp(habit.fluting, 0, 1)),
      width: lerpNumber(0.95, 0.55, share),
    })
  }

  for (const sample of trunk.spine) {
    const fade = smoothstep(reach, 0, sample.position.y)
    if (fade <= 0.001) continue
    sample.crossSection = {
      ...sample.crossSection,
      // Sharper near the ground and softening upward, so the ribs taper out of
      // the column instead of stopping at a hard ring.
      fins: rootFins.map((fin) => ({
        direction: fin.direction,
        strength: fin.strength * Math.pow(fade, 1.5),
        width: fin.width * lerpNumber(1.5, 1, fade),
      })),
    }
  }

  // The root's own emergence is widened to match the rib it grows out of, so
  // the two surfaces already agree where the collar has to blend them.
  for (const root of roots) {
    const count = root.spine.length
    for (let index = 0; index < count; index += 1) {
      const t = index / Math.max(1, count - 1)
      const merge = smoothstep(0.3, 0, t)
      if (merge <= 0.001) continue
      const sample = root.spine[index]!
      sample.crossSection = {
        ...sample.crossSection,
        radiusX: sample.crossSection.radiusX * lerpNumber(1, 1.5, merge),
        radiusZ: sample.crossSection.radiusZ * lerpNumber(1, 1.35, merge),
      }
    }
  }
}

/**
 * Forces the last stretch of every root under the soil.
 *
 * A root is swept as a tube and capped at its end. If that end is still above
 * ground the cap faces the camera as a flat disc of concentric rings — it reads
 * as a sawn log lying in the grass, which is worse than no root at all. The
 * arch profile *usually* buries the tip, but "usually" is not good enough for
 * something a player can walk right up to, so the last samples are clamped
 * outright rather than tuned into place.
 */
function buryRootEnds(
  parts: SemanticTreePart[],
  environment: TreeEnvironment,
): void {
  for (const part of parts) {
    if (part.type !== 'root') continue
    const count = part.spine.length
    for (let index = 0; index < count; index += 1) {
      // Only the outer quarter, so the visible arches nearer the trunk keep the
      // exposure they were given.
      const t = index / Math.max(1, count - 1)
      const commitment = smoothstep(0.72, 1, t)
      if (commitment <= 0) continue
      const sample = part.spine[index]!
      const ground = groundHeightAt(
        sample.position.x,
        sample.position.z,
        environment.groundHeight,
        environment.slopeX,
        environment.slopeZ,
      )
      // Crown of the tube a clear margin below the surface.
      const ceiling = ground - sample.crossSection.radiusZ * (0.25 + commitment * 0.5)
      const target = ceiling - sample.crossSection.radiusZ
      if (sample.position.y <= target) continue
      sample.position.y = lerpNumber(sample.position.y, target, commitment)
      sample.burialDepth = ground - sample.position.y
    }
  }
}

/**
 * Ages major unions into the parent instead of leaving child pipes on its skin.
 *
 * The swelling from every child is accumulated first and applied once. Applying
 * each child's contribution as its own multiply compounds: a limb in a colonised
 * crown carries dozens of children, many of them at the same station, and
 * thirty successive multiplies by 1.13 turn a fifteen-centimetre branch into a
 * hundred-metre one. The relaxation pass downstream then flings that sample
 * across the map, which is what the stray sheets of geometry were.
 */
function applyLoadSwelling(parts: SemanticTreePart[]): void {
  const byId = new Map(parts.map((part) => [part.id, part]))
  const swellingByPart = new Map<string, Float64Array>()
  const loadAngles = new Map<string, { weight: number; angle: number }[]>()

  for (const child of parts) {
    if (!child.parentId || child.type === 'root' || child.branchOrder > 2) continue
    const parent = byId.get(child.parentId)
    if (!parent) continue
    const parentAtUnion = samplePart(parent, child.attachment).radius
    const load = clamp(
      child.spine[0]!.radius / Math.max(0.001, parentAtUnion),
      0.15,
      0.92,
    )
    let swelling = swellingByPart.get(parent.id)
    if (!swelling) {
      swelling = new Float64Array(parent.spine.length)
      swellingByPart.set(parent.id, swelling)
    }
    const childDirection = tangentAt(child, 0.08)
    const loadAngle = Math.atan2(childDirection.z, childDirection.x)
    const influenceWidth = parent.type === 'trunk' ? 0.13 : 0.095
    const angles = loadAngles.get(parent.id) ?? []
    for (let index = 0; index < parent.spine.length; index += 1) {
      const amount = index / Math.max(1, parent.spine.length - 1)
      const influence = smoothstep(
        influenceWidth,
        0,
        Math.abs(amount - child.attachment),
      )
      if (influence <= 0) continue
      swelling[index]! += influence * load * (parent.type === 'trunk' ? 0.18 : 0.13)
      if (influence > 0.55) angles.push({ weight: influence, angle: loadAngle })
    }
    loadAngles.set(parent.id, angles)
  }

  for (const [partId, swelling] of swellingByPart) {
    const parent = byId.get(partId)
    if (!parent) continue
    for (let index = 0; index < parent.spine.length; index += 1) {
      // Wound wood can double a union's girth; it cannot do more than that,
      // however many limbs leave at the same place.
      const total = clamp(swelling[index]!, 0, 1)
      if (total <= 0) continue
      const sample = parent.spine[index]!
      sample.radius *= 1 + total * 0.58
      sample.crossSection.radiusX *= 1 + total
      sample.crossSection.radiusZ *= 1 + total * 0.42
    }
    // One blended union direction rather than a chain of partial rotations
    // toward each child in turn.
    const angles = loadAngles.get(partId)
    if (!angles || angles.length === 0) continue
    let sine = 0
    let cosine = 0
    let weight = 0
    for (const entry of angles) {
      sine += Math.sin(entry.angle) * entry.weight
      cosine += Math.cos(entry.angle) * entry.weight
      weight += entry.weight
    }
    if (weight <= 0) continue
    const blended = Math.atan2(sine, cosine)
    for (let index = 0; index < parent.spine.length; index += 1) {
      const total = clamp(swelling[index]!, 0, 1)
      if (total <= 0.15) continue
      const sample = parent.spine[index]!
      sample.crossSection.rotation = lerpNumber(
        sample.crossSection.rotation,
        blended,
        Math.min(0.34, total * 0.34),
      )
    }
  }
}

/** Leonardo-style area conservation, biased toward the semantic continuation. */
function solveRadiusInheritance(parts: SemanticTreePart[]): void {
  const byId = new Map(parts.map((part) => [part.id, part]))
  for (const parent of parts) {
    const children = parent.children
      .map((id) => byId.get(id))
      .filter((part): part is SemanticTreePart => Boolean(part) && part!.type !== 'root')
    if (children.length === 0) continue
    const groups = new Map<number, SemanticTreePart[]>()
    for (const child of children) {
      const bucket = Math.round(child.attachment * 12)
      const group = groups.get(bucket) ?? []
      group.push(child)
      groups.set(bucket, group)
    }
    for (const group of groups.values()) {
      const parentRadius = samplePart(parent, group[0]!.attachment).radius
      const availableArea = parentRadius * parentRadius * 0.86
      let requestedArea = 0
      for (const child of group) {
        const semanticWeight = child.id === parent.continuationChildId ? 1.28 : 1
        requestedArea += child.spine[0]!.radius ** 2 * semanticWeight
      }
      if (requestedArea <= availableArea) continue
      const scale = Math.sqrt(availableArea / requestedArea)
      for (const child of group) {
        for (const sample of child.spine) {
          sample.radius *= scale
          sample.crossSection.radiusX *= scale
          sample.crossSection.radiusZ *= scale
        }
      }
    }
  }
}

/**
 * Foliage stations sit on the twiggy ends of the growth tree, not on the swept
 * limbs. Each one becomes a small clump of leaf cards, so the crown is built
 * from overlapping sprays hanging off real branchlets rather than from loose
 * leaves scattered through a lobe-shaped volume.
 */
function createFoliageClusters(
  nodes: readonly GrowthNode[],
  parameters: TreeParameters,
  architecture: SpeciesArchitecture,
  random: TreeRandom,
): FoliageCluster[] {
  if (parameters.foliageDensity <= 0.01 || nodes.length === 0) return []
  const carriers: number[] = []
  const threshold = architecture.meshedTipRadius * 3.4
  for (const [index, node] of nodes.entries()) {
    if (node.parent < 0) continue
    if (node.radius > threshold) continue
    carriers.push(index)
  }
  if (carriers.length === 0) return []

  // Subsampling to a target rather than taking every twig keeps the card count
  // — and so the fill cost — stable across recipes that ramify very
  // differently. The target is deliberately low and the cards correspondingly
  // large: closing a crown with a few big sprays is far cheaper to shade than
  // closing the same volume with many small ones, and overdraw on alpha-tested
  // foliage is where a tree's frame budget actually goes.
  const target = Math.round(
    lerpNumber(420, 1_500, clamp(parameters.foliageDensity, 0, 1)),
  )
  const stride = Math.max(1, carriers.length / target)
  const clusters: FoliageCluster[] = []
  for (let cursor = 0; cursor < carriers.length; cursor += stride) {
    const index = carriers[Math.floor(cursor)]!
    const node = nodes[index]!
    const parent = nodes[node.parent]!
    const axis = normalize(subtract(node.position, parent.position), node.direction)
    const scale = random.range(0.82, 1.28)
    const radius = architecture.cardSize * scale
    clusters.push({
      id: `foliage-${clusters.length + 1}`,
      partId: `growth-${index}`,
      center: add(node.position, multiply(axis, radius * 0.32)),
      axis,
      radius,
      depth: radius * random.range(0.78, 1.22),
      occlusion: node.occlusion,
      seed: Math.floor(random.unit() * 0x7fffffff),
    })
  }
  return clusters
}

function graphBounds(graph: SemanticTreeGraph) {
  const bounds = emptyBounds()
  for (const part of graph.parts) {
    for (const sample of part.spine) {
      includeInBounds(
        bounds,
        sample.position,
        Math.max(sample.crossSection.radiusX, sample.crossSection.radiusZ),
      )
    }
  }
  for (const cluster of graph.foliageClusters) {
    includeInBounds(bounds, cluster.center, cluster.radius)
  }
  return bounds
}
