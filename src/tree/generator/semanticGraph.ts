import {
  add,
  clamp,
  cross,
  dot,
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
import { treeSpeciesDefinition } from './speciesCatalog'
import { growRegimeCrown } from './growth/regimeCrown'
import { growSupportRoots } from './growth/supportRoots'
import {
  allocateColonizedFoliage,
  foliageStationTarget,
} from './growth/foliageAllocation'
import { fitAerialRootsToCarriers } from './growth/descendingRoot'
import type { FruitClusterDraft, GrowthAxisDraft, OrganStationDraft } from './growth/types'
import { trunkRadiusMultiplier } from './growth/trunkProfile'
import {
  palmTrunkProfile,
  palmTrunkStation,
} from './growth/profiles/palmTrunkProfiles'
import {
  baobabBoleStation,
  baobabMeanderAmplitudeLimit,
} from './growth/profiles/baobabBoleProfile'
import { boleProfile, boleStation } from './growth/profiles/boleProfiles'

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
  const species = treeSpeciesDefinition(parameters.species)
  const habit = deriveTreeHabit(parameters)
  const parts: SemanticTreePart[] = []

  const trunk = createTrunk(parameters, architecture, habit, random)
  parts.push(trunk)

  // A co-dominant tree is not one bole with two big branches: the *trunk*
  // divides, and both halves carry bark, girth and their own crown from there
  // up. Modelling it as branches left every tree in the set standing on the
  // same single column, which is most of why they all read as the same tree.
  const stems = species.growthModel === 'colonized-crown'
    ? createCodominantStems(parameters, habit, random, trunk)
    : []
  parts.push(...stems)
  for (const stem of stems) connect(trunk, stem, stem.junctionType === 'continuation')

  const boles = stems.length > 0 ? stems : [trunk]
  let crownBranches: SemanticTreePart[] = []
  let crownNodes: GrowthNode[] = []
  let regimeOrgans: OrganStationDraft[] = []
  let regimeFruits: FruitClusterDraft[] = []
  if (species.growthModel === 'colonized-crown') {
    const crown = growCrownParts(parameters, architecture, habit, random, trunk, boles)
    parts.push(...crown.parts)
    crownBranches = crown.branches
    crownNodes = crown.nodes
  } else {
    const regime = growRegimeCrown(parameters, trunk, random)
    const byId = new Map(parts.map((part) => [part.id, part]))
    for (const axis of regime.axes) {
      const part = regimeAxisToPart(axis, parameters, random)
      parts.push(part)
      crownBranches.push(part)
      const parent = byId.get(part.parentId!)
      if (parent) connect(parent, part, axis.continuation)
      byId.set(part.id, part)
    }
    regimeOrgans = regime.organs
    regimeFruits = regime.fruits ?? []
  }

  // Stubs of the limbs this individual actually lost, at the scars the trunk
  // already swelled around, rather than a fixed quota at arbitrary places.
  for (const [index, wound] of (species.growthModel === 'colonized-crown'
    ? habit.lostLimbs
    : []).entries()) {
    const stub = createDeadStub(parameters, random, trunk, index, wound)
    parts.push(stub)
    connect(trunk, stub, false)
  }
  // Stag head: the bare spars of the old crown standing clear above the living
  // one. On a retrenching veteran this is the silhouette — a dense low mass
  // with dead antlers over it — and it is the single most identifiable
  // ancient-oak profile there is.
  for (let index = 0; index < habit.deadSparCount; index += 1) {
    const carrier = crownBranches
      .filter((branch) => branch.branchOrder <= 1)
      .sort((a, b) => b.spine.at(-1)!.position.y - a.spine.at(-1)!.position.y)
    const parent = carrier[index % Math.max(1, carrier.length)]
    if (!parent) break
    const spar = createDeadSpar(parameters, habit, random, parent, index)
    parts.push(spar)
    connect(parent, spar, false)
  }

  // Exotic support-root species carry most of their load above ground. A
  // second full radial root fan underneath them hides that defining topology
  // and produces a generic starburst base, so retain only a small anchoring
  // set where it is botanically useful.
  const basalRootCount = species.rootModel === 'prop' || species.rootModel === 'fibrous-mat'
    ? 0
    : species.rootModel === 'aerial-support'
      ? Math.min(4, parameters.rootCount)
      : species.rootModel === 'wrapping-fused'
        ? Math.min(3, parameters.rootCount)
        : parameters.rootCount
  const structuralRoots: SemanticTreePart[] = []
  for (let index = 0; index < basalRootCount; index += 1) {
    const root = createStructuralRoot(
      parameters,
      habit,
      environment,
      random,
      index,
      trunk,
      crownBranches,
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

  for (const supportRoot of growSupportRoots(
    parameters,
    environment,
    boles,
    crownBranches,
    random,
  )) {
    parts.push(supportRoot)
    const parent = parts.find((part) => part.id === supportRoot.parentId)
    if (parent) connect(parent, supportRoot, false)
  }

  raiseButtresses(parts, trunk, habit, parameters)
  buryRootEnds(parts, environment)
  applyLoadSwelling(parts)
  solveRadiusInheritance(parts)
  // After inheritance, not before: a carrier limb that has just been scaled
  // down to fit its own parent must not be left thinner than the pillar it
  // holds up.
  fitAerialRootsToCarriers(parts)
  const graph: SemanticTreeGraph = {
    seed: parameters.seed,
    parts,
    contacts: [],
    foliageClusters: [],
    fruitClusters: [],
    bounds: emptyBounds(),
  }
  resolveTreeSpace(graph, environment, parameters)
  graph.foliageClusters = species.growthModel === 'colonized-crown'
    ? allocateColonizedFoliage(
        crownNodes,
        crownBranches,
        parameters,
        architecture,
        random,
      )
    : (() => {
      // A frond bound to its bearer's tip is right when the bearer *is* the
      // petiole — one organ, one axis, as an apical palm crown builds it. It is
      // destructive when a single apex carries a whole fan: every frond in that
      // head then inherits the same centre and the same bearing, and the crown
      // collapses to a flat radial carpet however carefully its leaf ages and
      // lifts were authored.
      const organsPerBearer = new Map<string, number>()
      for (const organ of regimeOrgans) {
        organsPerBearer.set(organ.partId, (organsPerBearer.get(organ.partId) ?? 0) + 1)
      }
      return regimeOrgans.map((organ, index) => {
        const bearer = organ.organModel === 'frond' &&
          (organsPerBearer.get(organ.partId) ?? 0) === 1
          ? parts.find((part) => part.id === organ.partId)
          : undefined
        const resolvedAxis = bearer && bearer.spine.length > 1
          ? normalize(
              subtract(
                bearer.spine.at(-1)!.position,
                bearer.spine.at(-2)!.position,
              ),
              organ.axis,
            )
          : organ.axis
        return {
          id: `organ-${index + 1}`,
          partId: organ.partId,
          // Bind to the resolved bearer rather than duplicating its authored
          // endpoint. This remains exact if future environment constraints
          // legitimately move the whole apical assembly.
          center: bearer
            ? add(bearer.spine.at(-1)!.position, multiply(resolvedAxis, -0.035))
            : organ.center,
          axis: resolvedAxis,
          radius: organ.radius,
          depth: organ.depth,
          occlusion: organ.occlusion,
          senescence: organ.senescence,
          development: organ.development,
          organModel: organ.organModel,
          seed: organ.seed,
        }
      })
    })()
  graph.fruitClusters = regimeFruits.map((fruit, index) => {
    const bearer = parts.find((part) => part.id === fruit.partId)
    return {
      id: `fruit-cluster-${index + 1}`,
      model: fruit.model,
      partId: fruit.partId,
      center: bearer?.spine.at(-1)?.position ?? fruit.center,
      axis: fruit.axis,
      radial: fruit.radial,
      strandCount: fruit.strandCount,
      spread: fruit.spread,
      length: fruit.length,
      fruitRadius: fruit.fruitRadius,
      count: fruit.count,
      seed: fruit.seed,
    }
  })
  graph.bounds = graphBounds(graph)
  return graph
}

function regimeAxisToPart(
  axis: GrowthAxisDraft,
  parameters: TreeParameters,
  random: TreeRandom,
): SemanticTreePart {
  const spine = axis.samples.map((sample, index) => {
    const swell = sample.swell ?? 1
    const radius = sample.radius * swell
    const crossSection = branchCrossSection(
      radius,
      index / Math.max(1, axis.samples.length - 1),
      parameters,
      random,
      axis.branchOrder * 17 + index,
    )
    // A dichotomy leaves a node that is widest across the split plane and
    // narrowest along it, because the two daughters press together as they
    // thicken. Expressing it on the cross-section keeps the fork inside the
    // same swept surface instead of needing a separately meshed collar.
    const flatten = sample.flatten ?? 0
    if (flatten > 0 && sample.flattenAxis) {
      const across = normalize(sample.flattenAxis, vec3(1, 0, 0))
      crossSection.rotation = Math.atan2(across.z, across.x)
      crossSection.radiusX = radius * (1 + flatten)
      crossSection.radiusZ = radius * (1 - flatten * 0.62)
    }
    return { position: sample.position, radius, burialDepth: 0, crossSection }
  })
  return {
    id: axis.id,
    type: spine[0]!.radius < 0.06 ? 'twig' : 'branch',
    parentId: axis.parentId,
    children: [],
    branchOrder: axis.branchOrder,
    age: parameters.age * clamp(1 - axis.branchOrder * 0.12, 0.25, 1),
    vigor: clamp(1 - axis.branchOrder * 0.12, 0.2, 1),
    dominance: clamp(1 - axis.branchOrder * 0.2, 0.08, 1),
    attachment: axis.attachment,
    junctionType: axis.continuation
      ? 'continuation'
      : axis.branchOrder <= 1 ? 'bifurcation' : 'lateral',
    embedded: axis.embedded,
    spine,
  }
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
  const divisionHeight = habit.forkHeight > 0
    ? clamp(habit.forkHeight, 0.04, 0.48)
    : 1
  const height = parameters.height * architecture.boleFraction * habit.snapHeight *
    divisionHeight
  const trunkProfile = treeSpeciesDefinition(parameters.species).trunkProfile
  const speciesBole = boleProfile(parameters.species)
  const palmProfile = trunkProfile === 'palm-column'
    ? palmTrunkProfile(parameters.species)
    : undefined
  const sampleCount = palmProfile
    // Four axial stations are enough to describe a local scar lip. The old
    // eight-station sampling was then retained verbatim by the hero mesher,
    // spending tens of thousands of triangles on a corrugated cylinder.
    ? Math.max(96, Math.ceil(height / palmProfile.ringSpacing) * 4 + 1)
    // An authored bole path carries real curvature and a girth field with two
    // waves in it; eighteen stations turn both into a polyline of straight
    // sections with visible axial seams between them.
    // Stations proportional to the bole's own length: enough to resolve the
    // authored curvature, without oversampling a two-metre stool into hundreds
    // of near-coincident rings.
    : speciesBole ? Math.round(clamp(height * 5, 22, 56))
    : parameters.species === 'ancient-oak' ? 22 : 18
  const pine = parameters.species === 'windswept-pine'
  const ancient = parameters.species === 'ancient-oak'
  const veteranWood = ancient || parameters.species === 'live-oak'
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
    // A low stool is only the first few percent of a full bole, not an entire
    // trunk squeezed into a metre. Evaluating taper against its real height is
    // essential for divided and fused trees: tapering this short base all the
    // way to the terminal radius, then tapering every child again, made even a
    // maximum-radius braid look implausibly thin.
    const boleT = t * divisionHeight
    const oldWood = parameters.age * smoothstep(0, 0.55, 1 - boleT)
    // Lean accumulates with height rather than tilting the whole column off its
    // base, because a tree that leans grew that way rather than being pushed.
    const leanOffset = t * t * height * Math.tan(habit.lean)
    const requestedMeander = habit.sinuosity * parameters.trunkRadius
    const meanderAmplitude = parameters.species === 'baobab'
      ? Math.min(
          requestedMeander,
          baobabMeanderAmplitudeLimit(
            height,
            parameters.trunkRadius,
            habit.sinuosityTurns,
          ),
        )
      : requestedMeander
    // A species bole path owns the centre line outright. Adding the generic
    // habit meander on top stacks two independent wanders and produces the
    // corkscrew stack of sausages review rejected.
    const meander = (speciesBole ? 0 : 1) *
      Math.sin(t * Math.PI * habit.sinuosityTurns * 2 + meanderPhase) *
      meanderAmplitude *
      // Almost none at the butt — the base of a bole is anchored — building
      // through the middle and easing off at the top.
      smoothstep(0, 0.35, t) * (1 - t * 0.25)
    // The authored species path replaces the generic palm sweep too. Doum has
    // both a palm surface profile and a forked-palm bole profile; accumulating
    // both centre-line fields doubled its lean and wobble.
    const palmSweep = palmProfile && !speciesBole
      ? Math.sin(t * Math.PI) * parameters.trunkRadius * palmProfile.sweep *
        (0.55 + parameters.sinuosity * 0.45)
      : 0
    const palmWobble = palmProfile && !speciesBole
      ? Math.sin(t * Math.PI * 2.15 + meanderPhase * 0.7) *
        Math.sin(t * Math.PI) * parameters.trunkRadius * palmProfile.sweepWobble
      : 0
    const position = vec3(
      leanX * leanOffset + meanderX * (meander + palmSweep) - meanderZ * palmWobble,
      // The butt starts below the soil. A trunk that begins exactly at ground
      // level shows its own end cap as a hard flat disc cut across the base,
      // and no amount of root work hides a straight line through the flare.
      lerpNumber(-buriedButt, height, t),
      leanZ * leanOffset + meanderZ * (meander + palmSweep) + meanderX * palmWobble,
    )
    const taper = Math.pow(1 - boleT, ancient ? 0.62 : 0.72)
    // Two flares superposed: a wide, shallow one for the whole butt and a tight
    // one right at the ground where the buttress roots merge in. One smooth
    // curve gives the traffic-cone base that reads as procedural immediately.
    // Deliberately modest. A big smooth flare swallows the buttress roots
    // whole, so the base reads as one moulded elephant foot with nothing
    // emerging from it; the roots are supposed to carry that silhouette.
    const baseFlare = 1 +
      smoothstep(0.34, 0, boleT) *
        (ancient ? 0.16 + parameters.age * 0.12 : 0.14) +
      smoothstep(0.09, 0, boleT) *
        (ancient ? 0.2 + parameters.age * 0.16 : 0.16)
    // An open scaffold crown owns the continuation above the bole. Leaving the
    // generic forty-two-percent terminal there produces a thick flat stump in
    // the middle of the crown even though a living continuation starts at it.
    const openScaffold = parameters.species === 'umbrella-acacia' ||
      parameters.species === 'live-oak'
    const terminalFraction = openScaffold ? 0.12 : ancient ? 0.52 : pine ? 0.28 : 0.42
    // A broken bole does not taper to a point: it stays thick and stops.
    const snapSwell = habit.snapHeight < 1
      ? 1 + smoothstep(0.7, 1, t) * 0.22
      : 1
    // Wound wood piles up around old limb scars, so the bole is lumpy where it
    // has lost things rather than smoothly conical.
    let woundSwell = 1
    for (const wound of habit.lostLimbs) {
      woundSwell += smoothstep(0.16, 0, Math.abs(boleT - wound.height)) *
        wound.scale * 0.28
    }
    const genericMultiplier = terminalFraction + taper * (1 - terminalFraction)
    const palmStation = palmProfile
      ? palmTrunkStation(palmProfile, boleT, height, parameters.seed, parameters.age)
      : undefined
    // A species bole path, where one is authored. This is the reusable
    // replacement for adding another `parameters.species === ...` branch every
    // time a trunk needs its own character.
    const species_ = speciesBole
      ? boleStation(
          speciesBole,
          boleT,
          position.y,
          parameters.trunkRadius,
          parameters.seed,
          parameters.age,
          height,
        )
      : undefined
    if (species_) {
      position.x += meanderX * species_.offset - meanderZ * species_.crossOffset
      position.z += meanderZ * species_.offset + meanderX * species_.crossOffset
    }
    const baobabStation = parameters.species === 'baobab'
      ? baobabBoleStation(
          boleT,
          parameters.seed,
          parameters.age,
          position.y,
          parameters.trunkRadius,
        )
      : undefined
    const profileMultiplier = palmStation
      ? palmStation.radiusMultiplier
      : baobabStation
        ? baobabStation.radiusMultiplier
      : species_
        ? species_.radiusMultiplier
      : trunkProfile === 'tapered'
        ? genericMultiplier * baseFlare
        : trunkRadiusMultiplier(trunkProfile, boleT)
    const radius = parameters.trunkRadius * profileMultiplier * snapSwell * woundSwell
    spine.push({
      position,
      radius,
      burialDepth: 0,
      crossSection: {
        radiusX: radius * (baobabStation?.radiusXScale ??
          (1 + (palmStation?.ellipticity ?? oldWood * 0.08))),
        radiusZ: radius * (baobabStation?.radiusZScale ??
          (1 - (palmStation?.ellipticity ?? oldWood * 0.045) * 0.72)),
        // Spiral grain. A veteran's flutes wind around the bole over its
        // length rather than running as straight columns.
        rotation: baobabStation?.rotation ??
          (t * habit.twist + (palmStation?.scarPhase ?? 0) * 0.035),
        // Buttressing, not fluting. A high lobe count run up the whole bole
        // turned the trunk into a fluted column; real swelling is a handful of
        // broad ribs that die out a metre or two above the roots.
        lobeCount: baobabStation?.lobeCount ?? (palmProfile
          ? (boleT < 0.12 ? 9 : 7)
          : clamp(Math.round(parameters.rootCount * 0.6), 3, 5)),
        fusedStems: baobabStation?.fusedStems,
        fusedStemBlend: baobabStation?.fusedStemBlend,
        lobeStrength: baobabStation?.lobeStrength ?? (palmProfile
          ? palmProfile.leafBaseRelief * smoothstep(0.08, 1, boleT) *
              (0.22 + parameters.age * 0.42)
          : smoothstep(veteranWood ? 0.68 : 0.42, 0, boleT) *
            habit.fluting *
            (0.06 + parameters.age * (veteranWood ? 0.2 : 0.12))),
        // Persistent projecting boots survive only on the young upper column.
        // Older leaf bases erode to surface scars and belong in the bark maps.
        palmBootPhase: palmStation && boleT > palmProfile!.leafBaseZoneStart
          ? palmStation.scarPhase
          : undefined,
        palmRinged: parameters.species === 'coconut-palm',
        palmBootRelief: palmStation
          ? palmProfile!.ringRelief * lerpNumber(
              parameters.species === 'date-palm' || parameters.species === 'doum-palm'
                ? 0.28
                : 0.12,
              parameters.species === 'date-palm' || parameters.species === 'doum-palm'
                ? 0.52
                : 0.4,
              smoothstep(0.7, 0.94, boleT),
            )
          : undefined,
        palmBootRanks: palmProfile?.leafBaseRanks,
        palmBootRetention: palmProfile
          ? lerpNumber(
              palmProfile.erodedBootRetention,
              palmProfile.leafBaseRetention,
              smoothstep(0.64, 0.9, boleT),
            )
          : undefined,
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
  const stemCount = Math.max(2, habit.stemCount)
  const rawShares = habit.bolePlan === 'codominant'
    ? [habit.forkBalance, 1 - habit.forkBalance]
    : Array.from({ length: stemCount }, () => random.range(0.72, 1.28))
  const shareTotal = rawShares.reduce((sum, share) => sum + share, 0)
  const shares = rawShares.map((share) => share / shareTotal)
  const fused = habit.bolePlan === 'fused'
  const baseRadii = shares.map((share) => union.radius * Math.sqrt(share) *
    // Fused children start within the parent's area budget so the later radius
    // inheritance pass does not shrink their wood without also shrinking the
    // already-authored orbit. That mismatch was responsible for the thin
    // strands floating around an oversized invisible braid.
    (fused ? Math.sqrt(0.82) : 0.96))
  const meanBaseRadius = baseRadii.reduce((sum, radius) => sum + radius, 0) /
    baseRadii.length
  // Express orbit size in strand radii, not parent radii. This keeps two- and
  // three-stem braids equally legible and maintains the same degree of contact
  // when Trunk radius changes.
  const sharedOrbitRadius = fused
    ? meanBaseRadius / Math.sin(Math.PI / stemCount) * random.range(0.86, 0.94)
    : union.radius * random.range(0.38, 0.56)
  const loadAxisPhase = random.range(0, Math.PI * 2)
  const loadAxisAzimuth = random.range(0, Math.PI * 2)

  for (const [index, share] of shares.entries()) {
    const heading = azimuth + index * (Math.PI * 2 / stemCount) +
      random.range(fused ? -0.035 : -0.28, fused ? 0.035 : 0.28)
    // The heavier stem stands nearer to vertical and the lighter one leans off
    // it, which is how the pair resolve their shared load.
    const splay = (habit.bolePlan === 'multistem'
        ? random.range(0.16, 0.3)
        : lerpNumber(0.34, 0.14, share) * random.range(0.75, 1.3))
    // Never past the authored height. A dominant stem given twelve per cent
    // more than its share stood metres clear of the crown its own branches
    // build, and the mesher can only finish it with a cap — a blunt pole
    // sticking out of the canopy on every co-dominant species.
    const ceiling = Math.max(
      parameters.height * 0.15,
      parameters.height * habit.snapHeight - boleTop,
    )
    const length = fused
      ? Math.min(remaining, ceiling)
      : Math.min(
          remaining * lerpNumber(0.82, 1.12, clamp(share * stemCount, 0, 1)),
          ceiling,
        )
    // Preserve roughly twelve authored stations per turn. Six turns sampled at
    // the old fixed 26 points alias into angular chords and look kinked rather
    // than like a slow continuous braid.
    const sampleCount = fused
      ? Math.max(26, Math.ceil(Math.abs(habit.stemTwist) * 12) + 1)
      : 14
    // Area conservation across the union: two stems of a given girth need a
    // bole below them thick enough to carry both.
    const baseRadius = baseRadii[index]!
    const phase = random.range(0, Math.PI * 2)
    const loadAxis = createCompositeLoadAxis(
      union.position,
      length,
      sampleCount,
      habit,
      parameters.trunkRadius,
      loadAxisPhase,
      loadAxisAzimuth,
    )
    const loadFrames = transportedLoadFrames(loadAxis)
    const spine: TreeSpineSample[] = []
    for (let step = 0; step < sampleCount; step += 1) {
      const t = step / (sampleCount - 1)
      const frame = loadFrames[step]!
      const meander = Math.sin(t * Math.PI * 1.6 + phase) *
        baseRadius * habit.sinuosity * (fused ? 0.2 : 0.9) *
        smoothstep(0, 0.3, t)
      // Fused stems orbit a shared load axis; they do not splay away from it.
      // More than one turn makes each axis exchange front/back order several
      // times, while a pulsing bounded radius lets the boles press together and
      // part again like old stems that repeatedly inosculated.
      const orbitAngle = heading + habit.stemTwist * Math.PI * 2 * t
      const orbitDirection = normalize(add(
        multiply(frame.x, Math.cos(orbitAngle)),
        multiply(frame.z, Math.sin(orbitAngle)),
      ))
      const meanderDirection = normalize(add(
        multiply(frame.x, Math.cos(heading + Math.PI * 0.5)),
        multiply(frame.z, Math.sin(heading + Math.PI * 0.5)),
      ))
      const fusionPulse = fused
        ? 0.84 + Math.cos(t * Math.PI * 6 + 0.4) * 0.12
        : 1
      // Leave the shared stool decisively, then carry on with a much gentler
      // splay. A linear offset gives the child an almost vertical starting
      // tangent; the collar solver then has to travel metres before it reaches
      // the parent's side, making secondary boles appear to start in mid-air.
      const earlySeparation = (1 - Math.exp(-t * 9)) / (1 - Math.exp(-9))
      const separation = lerpNumber(t, earlySeparation, 0.52)
      // The orbit tapers with the wood. A fixed-width helix makes the shrinking
      // upper stems drift farther and farther apart; scaling both together
      // keeps them intertwined through the full structural axis.
      const stemTaper = (fused ? 0.55 : 0.42) +
        Math.pow(1 - t, 0.7) * (fused ? 0.45 : 0.58)
      const fusedRadius = sharedOrbitRadius * stemTaper *
        smoothstep(0, 0.11, t)
      // Release a little into the crown only after the braid has done its work.
      // This gives each axis room to carry scaffolds without turning the lower
      // two thirds back into a fork.
      const crownRelease = fused
        ? length * 0.035 * smoothstep(0.76, 1, t)
        : 0
      const radialOffset = fused
        ? fusedRadius * fusionPulse + crownRelease
        : length * splay * separation
      const position = add(
        loadAxis[step]!,
        add(
          multiply(orbitDirection, radialOffset),
          multiply(meanderDirection, meander),
        ),
      )
      // Swollen at the union and tapering hard: the buttress of wood a fork
      // grows to hold itself together is one of its most recognisable features.
      const unionSwell = fused
        // Start inside the parent area budget, then form a short shoulder just
        // above the union. Keeping the first station unswollen prevents the
        // inheritance solver from scaling the entire strand down.
        ? 1 + smoothstep(0, 0.045, t) * smoothstep(0.24, 0.045, t) *
          (0.12 + parameters.age * 0.1)
        : 1 + smoothstep(0.22, 0, t) * (0.28 + parameters.age * 0.22)
      // A trunk does not end in a stump. The last stretch resolves to a shoot
      // so the terminal cap is the size of a twig rather than a sawn disc.
      const terminalShoot = lerpNumber(1, 0.3, smoothstep(0.84, 1, t))
      const radius = Math.max(
        0.05,
        baseRadius * stemTaper * unionSwell * terminalShoot,
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
      dominance: clamp(share * stemCount, 0.35, 1),
      attachment: 1,
      // A braided union cannot share one parent ring with a centreline that
      // immediately orbits away from it: at high turn counts that creates a
      // non-manifold fan at the shared ring. Each fused axis is therefore its
      // own closed shell, overlapped inside the common stool. Ordinary forks
      // still carry one true topological continuation.
      junctionType: index === 0 && !fused ? 'continuation' : 'bifurcation',
      spine,
    })
  }
  return stems
}

interface LoadFrame {
  x: TreeVec3
  z: TreeVec3
}

/**
 * Builds the shared structural axis before any fork, multi-bole splay or fused
 * weave is applied. This is the composition point: a sinuous/leaning axis is
 * one curve, and every stem offset lives in that curve's transported frame.
 */
function createCompositeLoadAxis(
  origin: TreeVec3,
  height: number,
  sampleCount: number,
  habit: TreeHabit,
  trunkRadius: number,
  phase: number,
  azimuth: number,
): TreeVec3[] {
  const leanDirection = vec3(
    Math.cos(habit.leanAzimuth),
    0,
    Math.sin(habit.leanAzimuth),
  )
  const sinuousDirection = vec3(Math.cos(azimuth), 0, Math.sin(azimuth))
  const secondaryDirection = vec3(-sinuousDirection.z, 0, sinuousDirection.x)
  const amplitude = trunkRadius * habit.sinuosity
  const result: TreeVec3[] = []
  for (let step = 0; step < sampleCount; step += 1) {
    const t = step / Math.max(1, sampleCount - 1)
    const envelope = smoothstep(0, 0.16, t) * (1 - t * 0.12)
    const primary = Math.sin(
      t * Math.PI * 2 * habit.sinuosityTurns + phase,
    ) * amplitude * envelope
    const secondary = Math.sin(
      t * Math.PI * 2 * habit.sinuosityTurns * 0.53 + phase * 0.71,
    ) * amplitude * 0.28 * envelope
    const leanOffset = height * t * t * Math.tan(habit.lean)
    result.push(add(
      origin,
      add(
        vec3(0, height * t, 0),
        add(
          multiply(leanDirection, leanOffset),
          add(
            multiply(sinuousDirection, primary),
            multiply(secondaryDirection, secondary),
          ),
        ),
      ),
    ))
  }
  return result
}

/** Rotation-minimising frames for offsets around a curved load axis. */
function transportedLoadFrames(axis: readonly TreeVec3[]): LoadFrame[] {
  const tangents = axis.map((_, index) => normalize(
    subtract(
      axis[Math.min(axis.length - 1, index + 1)]!,
      axis[Math.max(0, index - 1)]!,
    ),
    vec3(0, 1, 0),
  ))
  const first = tangents[0]!
  const reference = Math.abs(first.y) < 0.82 ? vec3(0, 1, 0) : vec3(0, 0, 1)
  let x = normalize(cross(reference, first), vec3(1, 0, 0))
  const frames: LoadFrame[] = []
  for (const tangent of tangents) {
    x = normalize(
      subtract(x, multiply(tangent, dot(x, tangent))),
      vec3(1, 0, 0),
    )
    const z = normalize(cross(x, tangent), vec3(0, 0, 1))
    frames.push({ x, z })
  }
  return frames
}

/** The highest a scaffold is allowed to leave the bole, leaving a leader above. */
const SCAFFOLD_TOP = 0.97

/**
 * Where the scaffolds leave the bole, as an ascending list with uneven gaps.
 *
 * The jitter here used to be ±0.045 of total height against a mean gap several
 * times that, which is to say the ladder was even and the jitter was a rounding
 * error on it. Even spacing is the thing itself: a stem carrying limbs at
 * regular intervals is legible as a ladder from any distance, and real limb
 * spacing is nothing like it — it is the record of which buds broke in which
 * years and which of those survived the next twenty, so two limbs land a
 * handspan apart, then three metres of clean bole, then a cluster of three.
 *
 * Jittering by a large fraction of the *gap* rather than by a fixed fraction of
 * the tree gets that at every size, and — unlike redistributing the gaps
 * freely — it keeps the limb count, the span and the mean spacing exactly where
 * the architecture put them. That matters for more than tidiness: the woody
 * mesher's cost is superlinear in how much of the crown each limb ends up
 * carrying, and a free redistribution moved enough of the crown onto the lower,
 * thicker attachments to put a hero oak fifty per cent over its triangle
 * budget. This is the same silhouette change for none of that.
 */
function scaffoldHeights(
  count: number,
  lowest: number,
  random: TreeRandom,
): number[] {
  const span = Math.max(0.02, SCAFFOLD_TOP - lowest)
  const gap = count > 1 ? span / (count - 1) : span
  const heights: number[] = []
  for (let index = 0; index < count; index += 1) {
    const even = count === 1 ? 0.5 : index / (count - 1)
    // Up to two fifths of a gap either way, so a pair can end up at 0.2 of the
    // mean spacing and the next pair at 1.8 of it.
    const along = lowest + span * even + random.range(-0.42, 0.42) * gap
    heights.push(clamp(along, 0.12, 0.985))
  }
  // Jitter can swap the order of a close pair, and a scaffold list that is not
  // ascending would deal limbs to the wrong stem on a divided bole.
  return heights.sort((a, b) => a - b)
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
    architecture.scaffoldCount + (habit.trunkDamage === 'snapped' ? 2 : 0),
  )
  // Golden-angle phyllotaxy with real jitter: evenly spaced scaffolds around a
  // bole is the single most recognisable procedural tell.
  const azimuthOffset = random.range(0, Math.PI * 2)
  const lowest = architecture.lowestScaffold
  const scaffoldSpan = Math.max(0.02, SCAFFOLD_TOP - lowest)
  const heights = scaffoldHeights(scaffoldCount, lowest, random)
  for (let index = 0; index < scaffoldCount; index += 1) {
    // Dealt alternately between the stems, so a divided bole ends up with two
    // competing crowns rather than one stem carrying everything.
    const bole = boles[index % boles.length]!
    const along = heights[index]!
    // Where this limb sits between the lowest one and the leader. Nearly
    // everything about a scaffold follows from it.
    const heightBias = clamp((along - lowest) / scaffoldSpan, 0, 1)
    const source = samplePart(bole, along)
    const azimuth = azimuthOffset + index * GOLDEN_ANGLE + random.range(-0.5, 0.5)
    const outward = vec3(Math.cos(azimuth), 0, Math.sin(azimuth))
    // Low limbs leave the bole flatter than high ones, and that is not a
    // stylistic choice — a limb low on a stem spent its life reaching sideways
    // past its neighbours for light it could not get from above, while one at
    // the top has only ever had to keep up with the leader. Drawing every
    // limb's angle from the same distribution is what makes a crown read as a
    // shuttlecock: a fan of identical sticks at identical angles.
    const rise = lerpNumber(
      architecture.scaffoldRise[0],
      architecture.scaffoldRise[1],
      clamp(heightBias * 0.72 + random.unit() * random.unit() * 0.46, 0, 1),
    )
    const tangent = tangentAt(bole, along)
    seeds.push({
      position: add(source.position, multiply(outward, source.radius * 0.72)),
      direction: normalize(add(
        add(multiply(outward, 1), vec3(0, rise, 0)),
        multiply(tangent, architecture.scaffoldFollow),
      )),
      attachment: along,
      // The lowest limb on a veteran is the heaviest thing on it after the
      // bole. Taking the same random share at every height instead flattens
      // the hierarchy, and a crown of equal limbs has no hierarchy to read.
      availableRadius: source.radius
        * lerpNumber(0.62, 0.46, heightBias)
        * random.range(0.9, 1.06),
    })
    seedAttachments.push(along)
    seedParents.push(bole)
  }

  // Lateral limbs: the thinner, older, near-horizontal ones further down the
  // bole. See `SpeciesArchitecture.lateralLimbs` — they are zero for anything
  // grown in a closed canopy, because a clean bole is precisely what a closed
  // canopy produces.
  const lateralCount = Math.max(0, Math.round(architecture.lateralLimbs ?? 0))
  const lateralSpan = architecture.lateralSpan ?? [0.2, 0.55]
  for (let index = 0; index < lateralCount; index += 1) {
    const bole = boles[index % boles.length]!
    // Biased low within the band. The band is where limbs *can* be; most of
    // the survivors are near its bottom, because those are the ones that were
    // already big enough to hold their own when the crown closed over them.
    const along = clamp(
      lerpNumber(
        lateralSpan[0],
        lateralSpan[1],
        Math.pow(random.unit(), 0.7),
      ),
      0.1,
      Math.max(0.12, lowest - 0.02),
    )
    const source = samplePart(bole, along)
    const azimuth = azimuthOffset
      + (scaffoldCount + index) * GOLDEN_ANGLE
      + random.range(-0.75, 0.75)
    const outward = vec3(Math.cos(azimuth), 0, Math.sin(azimuth))
    // Level, and occasionally below level. A limb that has carried its own
    // weight for two centuries does not point upward at the bole.
    const rise = random.range(-0.08, 0.26)
    const tangent = tangentAt(bole, along)
    seeds.push({
      position: add(source.position, multiply(outward, source.radius * 0.78)),
      direction: normalize(add(
        add(multiply(outward, 1.3), vec3(0, rise, 0)),
        multiply(tangent, architecture.scaffoldFollow * 0.45),
      )),
      attachment: along,
      availableRadius: source.radius * random.range(0.1, 0.2),
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
      // Foliage density is a rendering-density control, not a growth control.
      // Above 1 we repeat smaller card stations on the existing carrier twigs;
      // changing attractor count here would also change the branch geometry.
      architecture.attractorCount * lerpNumber(
        0.55,
        1.15,
        clamp(parameters.foliageDensity, 0, 1),
      ),
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
  for (const bole of boles) byId.set(bole.id, bole)
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
    // A member is fixed at its attachment. Starting the procedural gnarl at
    // full amplitude displaces the child centreline before the collar solver
    // sees it; continuations then leave a hard circumferential shelf and
    // lateral limbs appear to tunnel out of the parent. Let deformation grow
    // over the first few stations, after the union has established continuity.
    const attachmentFade = smoothstep(0, 0.16, t)
    const amplitude = node.radius * gnarlWeight * 1.35 * attachmentFade
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
  const ceiba = parameters.species === 'kapok-ceiba'
  const baobab = parameters.species === 'baobab'
  const liveOak = parameters.species === 'live-oak'
  const pandanus = parameters.species === 'screw-pine-pandanus'
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
    ? Math.atan2(loadDirection.z, loadDirection.x) + random.range(-0.48, 0.48)
    : index * GOLDEN_ANGLE + parameters.seed * 0.00013 + random.range(-0.58, 0.58)
  const direction = normalize(vec3(Math.cos(angle), 0, Math.sin(angle)))
  const side = vec3(-direction.z, 0, direction.x)
  const length = parameters.rootSpread * random.range(0.46, 1.16) *
    lerpNumber(0.82, 1.18, structuralLoad) * (1 + Math.max(0, leanPull) * 0.5)
  const sampleCount = Math.max(14, Math.ceil(length / 0.5))
  // Buttressed roots climb the bole before they spread; sunken ones leave at
  // ground level. Where a root departs is most of what a base looks like — but
  // it has to be expressed in metres. As a *fraction of the bole* the same
  // number put a buttress two metres up a tall trunk, and the collar between it
  // and the ground came out as a huge flat sheet.
  const climbMetres = pandanus
    ? parameters.height * random.range(0.13, 0.24)
    : baobab
      ? parameters.trunkRadius * random.range(0.45, 0.68)
    : parameters.trunkRadius * (
    habit.rootForm === 'buttressed'
      ? random.range(0.9, 1.8) * (0.72 + habit.fluting)
      : habit.rootForm === 'stilted'
        ? random.range(0.55, 1.05)
        : random.range(0.05, 0.3)
  )
  const boleHeight = Math.max(0.5, trunk.spine.at(-1)!.position.y)
  const attachment = clamp(
    climbMetres / boleHeight + structuralLoad * 0.012,
    0.008,
    pandanus ? 0.34 : 0.2,
  )
  const source = samplePart(trunk, attachment)
  // Four load-bearing plates are enough to ground the tree. Making every root
  // equally broad and equally exposed creates a regular starfish base even
  // when their paths wander later.
  // Species that carry their load on pillars, stilts or a braid do not also
  // stand on broad surface plates. Their few anchoring roots sink at once, the
  // way a baobab's do, so the base is not littered with flat pressed shims.
  const rootModel = treeSpeciesDefinition(parameters.species).rootModel
  const aboveGroundLoad = rootModel === 'aerial-support' ||
    rootModel === 'prop' ||
    rootModel === 'wrapping-fused' ||
    rootModel === 'stilt'
  const sinking = baobab || aboveGroundLoad
  const dominantButtress = !sinking && index < Math.min(
    ceiba ? 6 : liveOak ? 3 : 4,
    Math.max(1, primaryScaffolds.length),
  )
  // Sized against the bole's radius *where the root actually leaves it*, not
  // against the nominal trunk radius. A root that starts markedly thinner than
  // the flare it emerges from looks bolted on, which is most of why they read
  // as "suddenly starting" at the base.
  const flareRadius = Math.max(source.radius, parameters.trunkRadius)
  const baseRadius = flareRadius * (
    sinking
      ? random.range(0.2, 0.29)
      : pandanus
        ? random.range(0.2, 0.3)
      : dominantButtress
      ? random.range(
          ceiba ? 0.42 : liveOak ? 0.4 : 0.34,
          ceiba ? 0.58 : liveOak ? 0.56 : 0.48,
        )
      : random.range(0.15, 0.24)
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
    ? random.range(
        // A baobab does not carry surface plates. Its base is a flare with
        // shoulder ribs, and every metre of exposed strap on the terrain read
        // as a flat pressed shim in review. Sink them at once and let the
        // bole's own foot do the grounding.
        liveOak ? 0.42 : sinking ? 0.02 : 0.06,
        liveOak ? 0.58 : sinking ? 0.09 : 0.14,
      )
    : habit.rootForm === 'buttressed'
      ? (dominantButtress
          ? random.range(ceiba ? 0.58 : 0.38, ceiba ? 0.78 : 0.62)
          : random.range(0.12, 0.3)) *
        lerpNumber(0.82, 1.16, clamp(habit.fluting, 0, 1))
      : habit.rootForm === 'stilted'
        ? random.range(0.3, 0.5)
        : random.range(0.18, 0.38)
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
        length * (ceiba ? 0.035 : pandanus ? 0.045 : 0.1),
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
    const buttress = smoothstep(liveOak ? 0.18 : 0.3, 0.02, t)
    // The strap runs as far as the plate does: while a root is still a surface
    // rib it is broad and shallow, and it only rounds off once it sinks.
    const strap = smoothstep(0.06, 0.34, t) * smoothstep(1, plateEnd + 0.3, t)
    // Kept mild. Pushed hard the strap becomes a flat plank with a visible
    // faceted edge, which is worse than a slightly too-round root.
    const strapWidth = liveOak
      ? 1.9
      : habit.rootForm === 'buttressed' ? (ceiba ? 1.16 : 1.44) : 1.32
    const buttressWidth = habit.rootForm === 'buttressed' ? (ceiba ? 0.5 : 0.8) : 0.7
    const radiusX = radius *
      lerpNumber(1, lerpNumber(1, strapWidth, strap), 1 - buttress) *
      lerpNumber(1, buttressWidth, buttress)
    const strapDepth = liveOak ? 0.45 : 0.86
    const radiusZ = radius *
      lerpNumber(1, lerpNumber(1, strapDepth, strap), 1 - buttress) *
      lerpNumber(
        1,
        habit.rootForm === 'buttressed' ? (ceiba ? 2.8 : 1.9) : 1.65,
        buttress,
      )
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
    // Live-oak plates stay broad and exposed until they clear the bell of the
    // bole, then feather into the soil near the end of their run. Fading them
    // from the first station left the only above-ground samples hidden inside
    // the trunk flare even though the root graph itself extended for metres.
    const plate = liveOak
      ? smoothstep(plateEnd, plateEnd * 0.72, t)
      : smoothstep(plateEnd, 0.02, t)
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
    const plateLift = plate * radiusZ *
      ((liveOak ? 0.45 : 0.85) + relief * 0.8)
    const archLift = rhythm * remaining * Math.pow(1 - t, 0.45) *
      radiusZ * relief * 1.15
    // Anything barely proud of the soil is pushed under instead. A root that
    // clears the ground by a few centimetres over a short run does not read as
    // a root at all — it reads as a chip of bark lying in the grass.
    const exposure = Math.max(plateLift, archLift)
    const crownAboveGround = liveOak
      ? exposure
      : exposure * smoothstep(radiusZ * 0.18, radiusZ * 0.45, exposure)
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
    const departure = smoothstep(
      0.02,
      liveOak ? Math.max(0.12, plateEnd * 0.55) : plateEnd + 0.3,
      t,
    )
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
  const veteranWood = parameters.species === 'ancient-oak' ||
    parameters.species === 'live-oak'
  return {
    radiusX: radius * (1 + ageCompression + random.signed() * 0.018),
    radiusZ: radius * (1 - ageCompression * 0.5),
    rotation: t * (0.7 + parameters.gnarl * 1.4) + salt * 0.37,
    lobeCount: 3 + (salt % 3),
    lobeStrength: parameters.gnarl * (1 - t * 0.55) *
      (veteranWood ? 0.105 : 0.065),
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
      palmBootPhase: a.crossSection.palmBootPhase === undefined ||
        b.crossSection.palmBootPhase === undefined
        ? a.crossSection.palmBootPhase ?? b.crossSection.palmBootPhase
        : lerpNumber(
            a.crossSection.palmBootPhase,
            b.crossSection.palmBootPhase,
            amount,
          ),
      palmRinged: amount < 0.5
        ? a.crossSection.palmRinged
        : b.crossSection.palmRinged,
      palmBootRelief: lerpNumber(
        a.crossSection.palmBootRelief ?? 0,
        b.crossSection.palmBootRelief ?? 0,
        amount,
      ),
      palmBootRanks: amount < 0.5
        ? a.crossSection.palmBootRanks
        : b.crossSection.palmBootRanks,
      palmBootRetention: lerpNumber(
        a.crossSection.palmBootRetention ?? 0,
        b.crossSection.palmBootRetention ?? 0,
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
  // A palm's hundreds of hair-scale adventitious roots initiate below grade.
  // Treating each as a structural lateral fin sums them into a huge artificial
  // bell around the stipe—the exact opposite of a buried fibrous root plate.
  if (treeSpeciesDefinition(parameters.species).rootModel === 'fibrous-mat') return
  const roots = parts.filter(
    (part) => part.type === 'root' && part.parentId === trunk.id,
  )
  if (roots.length === 0) return
  const boleHeight = Math.max(0.5, trunk.spine.at(-1)!.position.y)
  const liveOak = parameters.species === 'live-oak'
  // A baobab has shoulders, not plates. Every root contributing a sharp rib
  // sums into a fluted bell around a bole this wide, which is why the species
  // used to be excluded from buttressing outright; ranking the roots and giving
  // only the strongest a broad, shallow ridge produces the lumpy asymmetric
  // spread the base actually has.
  const baobab = parameters.species === 'baobab'
  // Expressed in bole radii rather than as a fraction of height. A multi-bole
  // stool may be only half a metre tall, but the buttress load still continues
  // up the first couple of metres of every axis that rises from it.
  const desiredReach = liveOak
    ? parameters.trunkRadius * 1.85
    : baobab
      ? parameters.trunkRadius * 1.15
    : parameters.trunkRadius *
      lerpNumber(1.45, 3.8, clamp(habit.fluting, 0, 1)) *
      (habit.rootForm === 'buttressed' ? 1.18 : 1)

  interface RootFin {
    direction: TreeVec3
    strength: number
    width: number
  }
  const rootFins: RootFin[] = []
  const shoulderRoots = baobab
    ? [...roots]
        .sort((a, b) => b.spine[0]!.crossSection.radiusX - a.spine[0]!.crossSection.radiusX)
        .slice(0, Math.max(3, Math.round(roots.length * 0.55)))
    : roots
  for (const root of shoulderRoots) {
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
      strength: share * lerpNumber(0.5, 1.05, clamp(habit.fluting, 0, 1)) *
        (liveOak ? 1.2 : baobab ? 0.62 : 1),
      width: lerpNumber(0.95, 0.55, share) *
        (liveOak ? 0.9 : baobab ? 1.35 : 1),
    })
  }

  const basalAxes = [
    trunk,
    ...parts.filter(
      (part) => part.type === 'trunk' && part.parentId === trunk.id,
    ),
  ]
  // Ribs are measured from where the roots actually leave, not from the butt.
  // A deeply buried butt put the whole fade below grade, so a bole that was
  // supposed to carry shoulders two metres up met the terrain as a bare cone.
  const rootDatum = roots.reduce(
    (total, root) => total + root.spine[0]!.position.y,
    0,
  ) / roots.length
  for (const axis of basalAxes) {
    const baseY = axis === trunk
      ? Math.min(rootDatum, axis.spine[0]!.position.y + 0.05)
      : axis.spine[0]!.position.y
    const axisHeight = Math.max(0.05, axis.spine.at(-1)!.position.y - baseY)
    const reach = Math.min(
      axisHeight,
      axis === trunk ? Math.min(boleHeight, desiredReach) : desiredReach * 0.72,
    )
    const axisStrength = axis === trunk ? 1 : 0.48
    for (const sample of axis.spine) {
      const fade = smoothstep(reach, 0, sample.position.y - baseY)
      if (fade <= 0.001) continue
      sample.crossSection = {
        ...sample.crossSection,
        // Sharper near the ground and softening upward, so the ribs taper out
        // of the column instead of stopping at a hard ring.
        fins: rootFins.map((fin) => ({
          direction: fin.direction,
          strength: fin.strength * axisStrength * Math.pow(fade, 1.5),
          width: fin.width * lerpNumber(1.5, 1, fade),
        })),
      }
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
      // The collar mesh carries the visible shoulder. Parent swelling is only
      // the low, broad reaction-wood mound underneath it; scaling a whole
      // trunk cross-section by two made a lateral limb extrude a horizontal
      // shelf around the entire bole.
      const total = clamp(swelling[index]!, 0, 1)
      if (total <= 0) continue
      const sample = parent.spine[index]!
      const isTrunk = parent.type === 'trunk'
      sample.radius *= 1 + total * (isTrunk ? 0.08 : 0.11)
      sample.crossSection.radiusX *= 1 + total * (isTrunk ? 0.14 : 0.18)
      sample.crossSection.radiusZ *= 1 + total * (isTrunk ? 0.1 : 0.14)
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
      if (total <= 0.01) continue
      const sample = parent.spine[index]!
      // Rotation used to switch on at an arbitrary threshold and twist a
      // strongly lobed ring by a third of a turn in one axial segment. The
      // stitched ring became the giant diagonal "wedge" seen on Baobab.
      // Reaction wood may bias an ellipse, but it cannot rotate the entire
      // parent section toward every child.
      const bias = smoothstep(0.02, 0.85, total) *
        (parent.type === 'trunk' ? 0.035 : 0.055)
      sample.crossSection.rotation = lerpNumber(
        sample.crossSection.rotation,
        blended,
        bias,
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
        const continuation = child.id === parent.continuationChildId
        const startRadius = Math.max(1e-4, child.spine[0]!.radius)
        // A continuation's first station is literally the parent's terminal
        // ring: woodMesher reuses those vertex indices. Scaling that station as
        // though it were an independent daughter made the next ring drop by a
        // full Leonardo ratio and produced a visible knuckle at every semantic
        // part boundary. Preserve the shared ring, then reach the conserved
        // daughter girth smoothly through its emergence zone.
        //
        // Sampled at *this* child's attachment, not the group's. The bucket is
        // a twelfth of the member wide, so a scaffold leaving the bole just
        // under the apex shares a bucket with the leader — and if it happened
        // to be first in the list, the leader's shared ring was taken from the
        // parent's radius a twelfth of the way down, which is measurably wider
        // on a tapering bole. The result was a step at the top of the trunk
        // exactly where the mesher assumes there is none.
        const junctionScale = continuation
          ? samplePart(parent, child.attachment).radius / startRadius
          : scale
        for (let index = 0; index < child.spine.length; index += 1) {
          const station = index / Math.max(1, child.spine.length - 1)
          const emergence = continuation ? smoothstep(0, 0.28, station) : 1
          const localScale = lerpNumber(junctionScale, scale, emergence)
          const sample = child.spine[index]!
          sample.radius *= localScale
          sample.crossSection.radiusX *= localScale
          sample.crossSection.radiusZ *= localScale
        }
      }
    }
  }
}

export { foliageStationTarget }

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
    if (cluster.organModel === 'frond' || cluster.organModel === 'terminal-rosette') {
      includeInBounds(
        bounds,
        add(cluster.center, multiply(cluster.axis, cluster.depth)),
        cluster.radius,
      )
    }
  }
  return bounds
}
