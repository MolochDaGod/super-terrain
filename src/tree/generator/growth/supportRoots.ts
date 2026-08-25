import {
  clamp,
  groundHeightAt,
  lerpNumber,
  TreeRandom,
  vec3,
} from '../math'
import { treeSpeciesDefinition } from '../speciesCatalog'
import type {
  SemanticTreePart,
  TreeEnvironment,
  TreeParameters,
  TreeSpineSample,
  TreeVec3,
} from '../types'
import { samplePartPosition } from './axis'
import { descendingRoot, pillarAnchors } from './descendingRoot'

/**
 * Above-ground support roots are authored separately from basal roots. Aerial
 * pillars, mangrove props and strangler braids have different parents and load
 * paths; treating them as unusually exposed radial roots cannot reproduce the
 * topology even when their surface profile is exaggerated.
 */
export function growSupportRoots(
  parameters: TreeParameters,
  environment: TreeEnvironment,
  boles: readonly SemanticTreePart[],
  crownBranches: readonly SemanticTreePart[],
  random: TreeRandom,
): SemanticTreePart[] {
  switch (treeSpeciesDefinition(parameters.species).rootModel) {
    case 'aerial-support':
      return aerialPillars(parameters, environment, crownBranches, random)
    case 'prop':
      return propRoots(parameters, environment, boles, crownBranches, random)
    case 'wrapping-fused':
      return wrappingRoots(parameters, environment, boles, random)
    case 'fibrous-mat':
      return fibrousMat(parameters, environment, boles, random)
    case 'basal-surface':
    case 'buttress':
    case 'stilt':
      return []
  }
}

/**
 * A compact skirt of exposed primary roots which immediately disappears into
 * the substrate. Palms do not carry a handful of broad oak-like surface roots,
 * but a perfectly clipped cylinder is just as wrong: the dense adventitious
 * root mat makes a ragged, load-bearing collar at soil level.
 */
function fibrousMat(
  parameters: TreeParameters,
  environment: TreeEnvironment,
  boles: readonly SemanticTreePart[],
  random: TreeRandom,
): SemanticTreePart[] {
  const trunk = boles[0]
  if (!trunk) return []
  const count = Math.max(96, Math.min(128, parameters.rootCount * 12 + 24))
  const phase = random.range(0, Math.PI * 2)
  const centre = samplePartPosition(trunk, 0.025)
  return Array.from({ length: count }, (_, index) => {
    const angle = phase + index * Math.PI * (3 - Math.sqrt(5)) + random.range(-0.12, 0.12)
    const radial = vec3(Math.cos(angle), 0, Math.sin(angle))
    // A small first cohort forms the visible adventitious root boss. The rest
    // is buried: exposing a hundred equal fibres makes a radial brush, while
    // burying every one leaves a lathed cylinder cut off at the soil plane.
    const collarRoot = index < 8
    const baseRadius = parameters.trunkRadius * (collarRoot
      ? random.range(0.07, 0.11)
      : random.range(0.012, 0.026))
    const tipRadius = baseRadius * random.range(0.35, 0.62)
    const start = vec3(
      centre.x + radial.x * parameters.trunkRadius * (collarRoot
        ? random.range(1.02, 1.16)
        : random.range(0.68, 0.9)),
      groundAt(centre, environment) - baseRadius * (collarRoot
        ? random.range(0.62, 1.08)
        : random.range(3.4, 4.8)),
      centre.z + radial.z * parameters.trunkRadius * (collarRoot
        ? random.range(1.02, 1.16)
        : random.range(0.68, 0.9)),
    )
    const reach = parameters.trunkRadius * (collarRoot
      ? random.range(0.18, 0.38)
      : random.range(0.22, 0.72))
    const end = vec3(
      start.x + radial.x * reach,
      0,
      start.z + radial.z * reach,
    )
    // `supportPart` sinks its terminal centre by 1.5 tip radii. Counter that
    // here so the upper half of the fine root remains visible before entering
    // the soil instead of leaving only a ring of tiny disconnected teeth.
    end.y = groundAt(end, environment) - tipRadius * (collarRoot ? 1.8 : 3.2)
    return supportPart(
      `fibrous-root-${index + 1}`,
      trunk.id,
      0.025,
      start,
      end,
      baseRadius,
      tipRadius,
      random,
      0.018,
      0.025,
      // Buried initiation zone: these open inside the stipe's root mantle.
      true,
    )
  })
}

/**
 * Banyan pillar roots.
 *
 * Aerial roots start as threads hanging free from the underside of a limb, so
 * the first thing to get right is that they are far thinner than the wood they
 * hang from. Sizing them against the trunk gave every one a diameter greater
 * than its own carrier branch, and the result was a dozen uniform poles pushed
 * straight up through the canopy with flat caps on top.
 *
 * The second thing is that they arrive in company. Several threads from the
 * same stretch of limb reach the ground within a metre of each other, thicken
 * together and fuse into one braided column. Anchoring them in clusters is what
 * turns a ring of stilts into the grove of trunks a mature banyan reads as.
 */
function aerialPillars(
  parameters: TreeParameters,
  environment: TreeEnvironment,
  branches: readonly SemanticTreePart[],
  random: TreeRandom,
): SemanticTreePart[] {
  const carriers = branches
    .filter((branch) => branch.branchOrder <= 2 && branch.spine.at(-1)!.position.y >
      parameters.height * 0.38)
    .sort((a, b) => horizontalReach(b) - horizontalReach(a))
  if (carriers.length === 0) return []
  const columnCount = clamp(Math.round(parameters.rootCount * 0.65), 3, 7)
  const anchors = pillarAnchors(
    columnCount,
    vec3(0, 0, 0),
    parameters.crownRadius * 0.16,
    parameters.crownRadius * 0.78,
    random,
  )
  const parts: SemanticTreePart[] = []
  for (const [columnIndex, anchor] of anchors.entries()) {
    // A young column is one thread; an established one is a braid of several.
    const strands = random.integer(2, 4)
    const columnFoot = parameters.trunkRadius * random.range(0.3, 0.52)
    for (let strand = 0; strand < strands; strand += 1) {
      // Carriers are chosen for actually passing over the anchor, so a pillar
      // descends from the limb it belongs to rather than from across the crown.
      const parent = nearestCarrier(carriers, anchor) ??
        carriers[(columnIndex + strand) % carriers.length]!
      const attachment = attachmentNearest(parent, anchor)
      const source = samplePartPosition(parent, attachment)
      const carrierRadius = samplePartRadius(parent, attachment)
      const drop = Math.max(1, source.y)
      const strandAnchor = vec3(
        anchor.x + random.signed() * columnFoot * 0.9,
        0,
        anchor.z + random.signed() * columnFoot * 0.9,
      )
      // A column contains roots of several ages. The first strand is long
      // established and is a pillar almost from the limb down; later ones are
      // still thickening, and the last is often a fresh thread. All three at
      // once is what gives a banyan column its banded, braided silhouette.
      const maturity = strand === 0
        ? random.range(0.82, 1)
        : random.range(0.24, 0.78)
      parts.push(descendingRoot(
        `aerial-root-${columnIndex + 1}-${strand + 1}`,
        parent.id,
        attachment,
        source,
        strandAnchor,
        {
          samples: 14,
          // Always thinner than the limb it hangs from, but an old pillar is
          // still a substantial column at the top; only a new root is a thread.
          topRadius: Math.min(
            carrierRadius * 0.72,
            parameters.trunkRadius * lerpNumber(0.04, 0.3, maturity),
          ),
          footRadius: columnFoot * lerpNumber(0.34, 1, maturity),
          thickenFrom: lerpNumber(0.62, 0.1, maturity),
          wander: drop * random.range(0.035, 0.075),
          wanderTurns: random.range(1.6, 3.1),
          arch: random.range(0.02, 0.09),
          footFlare: random.range(0.24, 0.48),
          burial: random.range(1.4, 2.4),
        },
        random,
        environment,
      ))
    }
  }
  return parts
}

/** The carrier whose run passes closest to a ground anchor. */
function nearestCarrier(
  carriers: readonly SemanticTreePart[],
  anchor: TreeVec3,
): SemanticTreePart | undefined {
  let best: SemanticTreePart | undefined
  let bestDistance = Infinity
  for (const carrier of carriers) {
    for (const sample of carrier.spine) {
      const distance = Math.hypot(
        sample.position.x - anchor.x,
        sample.position.z - anchor.z,
      )
      if (distance < bestDistance) {
        bestDistance = distance
        best = carrier
      }
    }
  }
  return best
}

/** Where along a carrier it passes closest to a ground anchor. */
function attachmentNearest(carrier: SemanticTreePart, anchor: TreeVec3): number {
  let best = 0.5
  let bestDistance = Infinity
  const last = carrier.spine.length - 1
  for (let index = 0; index <= last; index += 1) {
    const sample = carrier.spine[index]!
    const distance = Math.hypot(
      sample.position.x - anchor.x,
      sample.position.z - anchor.z,
    )
    if (distance < bestDistance) {
      bestDistance = distance
      best = last === 0 ? 0.5 : index / last
    }
  }
  // Never the very tip: a root hanging off the end of a branch has nothing
  // above it and reads as a continuation of the branch rather than a root.
  return clamp(best, 0.3, 0.94)
}

/**
 * Rhizophora stilt roots.
 *
 * These leave the stem and the lower limbs well above the water, arch steeply
 * outward, and enter the substrate almost vertically — a tall open cone the
 * tree stands inside. The rejected version left the bole in its first fifth and
 * reached a long way out almost horizontally, which produced the low tangle a
 * reviewer read as intestines rather than the cage a mangrove actually has.
 */
function propRoots(
  parameters: TreeParameters,
  environment: TreeEnvironment,
  boles: readonly SemanticTreePart[],
  crownBranches: readonly SemanticTreePart[],
  random: TreeRandom,
): SemanticTreePart[] {
  const count = Math.max(9, parameters.rootCount + 4)
  const phase = random.range(0, Math.PI * 2)
  // Low scaffolds carry stilts too, which is what stacks the cage in height
  // instead of leaving one ring of arches around the base.
  // Chosen by girth, not by order. A primary on a slender tree can be thinner
  // than the stilt it would carry, and a root wider than its own parent is the
  // pole-through-the-canopy failure in miniature.
  const limbCarriers = crownBranches.filter((branch) =>
    branch.branchOrder <= 1 &&
    branch.spine[0]!.radius > parameters.trunkRadius * 0.34 &&
    branch.spine[0]!.position.y < parameters.height * 0.62)
  const parts: SemanticTreePart[] = []
  for (let index = 0; index < count; index += 1) {
    const fromLimb = limbCarriers.length > 0 && index % 3 === 2
    const parent = fromLimb
      ? limbCarriers[index % limbCarriers.length]!
      : boles[index % boles.length]!
    // High on the stem. A stilt leaving at ankle height is a surface root.
    const attachment = fromLimb
      ? random.range(0.12, 0.42)
      : random.range(0.24, 0.72)
    const source = samplePartPosition(parent, attachment)
    const sourceRadius = samplePartRadius(parent, attachment)
    const angle = phase + index * Math.PI * (3 - Math.sqrt(5)) + random.range(-0.26, 0.26)
    // Steep entry: the horizontal reach is a fraction of the height it drops
    // from, so the arch stands the tree up rather than sprawling it outward.
    const reach = Math.max(0.6, source.y) * random.range(0.42, 0.78)
    const anchor = vec3(
      source.x + Math.cos(angle) * reach,
      0,
      source.z + Math.sin(angle) * reach,
    )
    const footRadius = Math.min(sourceRadius * 0.5, parameters.trunkRadius * 0.2) *
      random.range(0.8, 1.2)
    parts.push(descendingRoot(
      `prop-root-${index + 1}`,
      parent.id,
      attachment,
      source,
      anchor,
      {
        samples: 12,
        topRadius: Math.min(sourceRadius * 0.42, parameters.trunkRadius * 0.24),
        footRadius,
        thickenFrom: random.range(0.5, 0.72),
        wander: reach * random.range(0.03, 0.08),
        wanderTurns: random.range(0.9, 1.7),
        // The defining shape: a strong outward bow that turns down again.
        arch: random.range(0.3, 0.52),
        footFlare: random.range(0.14, 0.3),
        burial: random.range(1.6, 2.6),
      },
      random,
      environment,
    ))
  }
  return parts
}

function wrappingRoots(
  parameters: TreeParameters,
  environment: TreeEnvironment,
  boles: readonly SemanticTreePart[],
  random: TreeRandom,
): SemanticTreePart[] {
  const count = Math.max(7, parameters.rootCount)
  const parts: SemanticTreePart[] = []
  const phase = random.range(0, Math.PI * 2)
  for (let index = 0; index < count; index += 1) {
    const parent = boles[index % boles.length]!
    const attachment = random.range(0.28, 0.76)
    const source = samplePartPosition(parent, attachment)
    const samples: TreeSpineSample[] = []
    const turns = random.range(0.42, 0.9) * (index % 2 === 0 ? 1 : -1)
    const startAngle = phase + index / count * Math.PI * 2
    const startRadius = parameters.trunkRadius * random.range(0.16, 0.25)
    const endRadius = parameters.trunkRadius * random.range(0.23, 0.36)
    for (let step = 0; step < 12; step += 1) {
      const t = step / 11
      const angle = startAngle + turns * Math.PI * 2 * t
      // Follow the actual bole centreline as the braid descends. Using world
      // origin here leaves wrapping roots floating beside any leaning or
      // sinuous trunk instead of remaining fused to its surface.
      const axisT = attachment * (1 - t)
      const centre = samplePartPosition(parent, axisT)
      const orbit = samplePartRadius(parent, axisT) * lerpNumber(1.05, 1.18, t) +
        lerpNumber(startRadius, endRadius, t)
      const x = centre.x + Math.cos(angle) * orbit
      const z = centre.z + Math.sin(angle) * orbit
      const ground = groundHeightAt(x, z, environment.groundHeight,
        environment.slopeX, environment.slopeZ)
      const y = lerpNumber(source.y, ground - endRadius * 1.4, t)
      const radius = lerpNumber(startRadius, endRadius, t)
      samples.push(sample(vec3(x, y, z), radius, angle))
    }
    parts.push(part(`wrapping-root-${index + 1}`, parent.id, attachment, samples, true))
  }
  return parts
}

function supportPart(
  id: string,
  parentId: string,
  attachment: number,
  source: TreeVec3,
  end: TreeVec3,
  startRadius: number,
  endRadius: number,
  random: TreeRandom,
  bow: number,
  arch: number,
  embedded = false,
): SemanticTreePart {
  const samples: TreeSpineSample[] = []
  const sideX = end.z - source.z
  const sideZ = source.x - end.x
  const sideLength = Math.max(1e-4, Math.hypot(sideX, sideZ))
  const phase = random.range(0, Math.PI * 2)
  for (let step = 0; step < 10; step += 1) {
    const t = step / 9
    const bend = Math.sin(t * Math.PI) * Math.hypot(end.x - source.x, end.z - source.z) * bow
    const meander = Math.sin(t * Math.PI * 2.3 + phase) *
      Math.sin(t * Math.PI) * sideLength * bow * 0.38
    const position = vec3(
      lerpNumber(source.x, end.x, t) + sideX / sideLength *
        (bend * Math.sin(phase) + meander),
      lerpNumber(source.y, end.y - endRadius * 1.5, t) +
        Math.sin(t * Math.PI) * Math.max(0, source.y - end.y) * arch,
      lerpNumber(source.z, end.z, t) + sideZ / sideLength *
        (bend * Math.sin(phase) + meander),
    )
    samples.push(sample(position, lerpNumber(startRadius, endRadius, t), phase))
  }
  return part(id, parentId, attachment, samples, false, embedded)
}

function sample(position: TreeVec3, radius: number, rotation: number): TreeSpineSample {
  return {
    position,
    radius,
    burialDepth: 0,
    crossSection: {
      radiusX: radius * 0.92,
      radiusZ: radius * 1.08,
      rotation,
      lobeCount: 3,
      lobeStrength: 0.08,
    },
  }
}

function part(
  id: string,
  parentId: string,
  attachment: number,
  spine: TreeSpineSample[],
  aerial = false,
  embedded = false,
): SemanticTreePart {
  return {
    id,
    type: 'root',
    embedded,
    parentId,
    children: [],
    branchOrder: 1,
    age: 0.82,
    vigor: 0.72,
    dominance: 0.6,
    attachment,
    junctionType: 'root-flare',
    aerial,
    spine,
  }
}

function horizontalReach(part: SemanticTreePart): number {
  const tip = part.spine.at(-1)!.position
  return Math.hypot(tip.x, tip.z)
}

function samplePartRadius(part: SemanticTreePart, t: number): number {
  const scaled = Math.max(0, Math.min(1, t)) * (part.spine.length - 1)
  const left = Math.floor(scaled)
  const right = Math.min(part.spine.length - 1, Math.ceil(scaled))
  return lerpNumber(part.spine[left]!.radius, part.spine[right]!.radius, scaled - left)
}

function groundAt(position: TreeVec3, environment: TreeEnvironment): number {
  return groundHeightAt(position.x, position.z, environment.groundHeight,
    environment.slopeX, environment.slopeZ)
}
