import {
  add,
  clamp,
  cross,
  dot,
  emptyBounds,
  hashUnit,
  includeInBounds,
  length,
  lerp,
  lerpNumber,
  multiply,
  normalize,
  subtract,
  vec3,
} from './math'
import { BARK_TILE_METRES } from '../materials/proceduralTreeTextures'
import {
  applyJunctionBlend,
  junctionNeighbourhood,
  type JunctionNeighbourhood,
} from './junctionBlend'
import {
  fusedStemRadius,
  fusedStemSegments,
  interpolateFusedStems,
} from './fusedStems'
import type {
  TreeButtressFin,
  SemanticTreeGraph,
  SemanticTreePart,
  TreeBounds,
  TreeCrossSection,
  TreeLodLevel,
  TreeMeshData,
  TreeSpineSample,
  TreeVec3,
} from './types'

export interface CurveSample {
  position: TreeVec3
  tangent: TreeVec3
  crossSection: TreeCrossSection
  burialDepth: number
  distance: number
}

export interface SweepFrame {
  tangent: TreeVec3
  x: TreeVec3
  z: TreeVec3
}

interface Ring {
  indices: number[]
  positions: TreeVec3[]
  center: TreeVec3
  frame: SweepFrame
}

interface CompiledPath {
  samples: CurveSample[]
  frames: SweepFrame[]
}

interface PartEndpoint {
  ring: Ring
  sample: CurveSample
  /**
   * World direction from the ring's centre to its vertex zero.
   *
   * A continuation is stitched to this ring index for index, so the child has
   * to start its own sweep with the same angular phase. Its frames are
   * parallel-transported from a world-up reference, which has no relationship
   * to the parent's phase at all, and the mismatch shears every quad of the
   * first band into the repeating triangular fishbone visible at each continued
   * generation.
   */
  vertexZero: TreeVec3
  /** Bark mapping and the v coordinate the parent finished on. */
  bark: BarkMapping
  barkV: number
}

interface AttachmentFrame {
  center: TreeVec3
  tangent: TreeVec3
  x: TreeVec3
  z: TreeVec3
  radiusX: number
  radiusZ: number
  fins?: readonly TreeButtressFin[]
}

interface MeshBuilder {
  positions: number[]
  colors: number[]
  uvs: number[]
  indices: number[]
}

interface MeshSettings {
  geometricError: number
  targetStep: number
  maximumTurn: number
  maximumRadial: number
  minimumRadial: number
  /**
   * Reciprocal of the budget loop's quality scale, applied to every radial
   * *minimum* as well as to the maximum.
   *
   * Without it the loop is not the contract the comment on it claims. Raising
   * `qualityScale` loosened the longitudinal error and the turn threshold, but
   * the radial segment count of a member whose cross section forces one — a
   * fused bole, a fluted buttress, a ribbed root — was a constant, and those
   * are exactly the members a dense recipe is made of. A six-turn fused stem
   * therefore returned over budget after all five rebuilds with the loop
   * having achieved nothing on the members that were over it.
   *
   * It is 1 on the first attempt, so nothing that already fits changes at all.
   */
  radialRelief: number
  level: TreeLodLevel
}

interface CompiledMesh {
  mesh: TreeMeshData
  includedPartCount: number
}

// A hero oak is the closest thing the camera gets to in this scene, and the
// crown's woody structure is most of what sells it. The previous 28k budget was
// spent before the secondary branches were meshed.
const LOD_TRIANGLE_BUDGETS = [110_000, 34_000, 6_000] as const

/** The bark texture is twice as tall as it is wide. */
/** The bark texture is twice as tall as it is wide. */
const BARK_TILE_ASPECT = 2

/** Girth at which the bark tile is used at its nominal size. */
const BARK_TILE_REFERENCE_RADIUS = 0.55

/**
 * Floor on how far the tile is allowed to shrink for a thin member.
 *
 * A ten-centimetre branch cannot show a whole tile around its circumference
 * without magnifying it several times, and letting the tile shrink to match
 * makes the pattern repeat every half metre along the branch — which reads as
 * corrugation, not bark. Holding a floor trades a little scale accuracy on
 * twigs for a surface that does not visibly loop.
 */
const BARK_TILE_MINIMUM_SCALE = 0.34

interface BarkMapping {
  /** Whole tiles around the circumference, so the seam at u=0 still matches. */
  repeats: number
  /** World height of one tile, matched to its actual world width. */
  metresPerTile: number
}

const barkMappingCache = new WeakMap<SemanticTreePart, BarkMapping>()
/** Where along the tile a member's v starts, so continuations stay seamless. */
const barkOriginCache = new WeakMap<SemanticTreePart, number>()

function barkOrigin(part: SemanticTreePart): number {
  return barkOriginCache.get(part) ?? part.branchOrder * 0.173
}

/**
 * How the bark tile lands on one member.
 *
 * Two things have to hold. The tile count around the circumference must be a
 * whole number or the seam at u=0 tears — and because a thin twig's whole
 * circumference is smaller than one tile, that count bottoms out at one, which
 * makes the tile's *effective* world width the circumference itself. The v rate
 * then has to come from that same width rather than from the nominal one, or
 * the texture ends up magnified across the member and left at trunk scale along
 * it: a branch drawn as a flat painted plank.
 *
 * The target tile also shrinks with the member's own girth, which is not a
 * cheat — young bark genuinely is finer than the plated bark of an old bole, so
 * a twig showing small fissures is the right answer rather than a compromise.
 *
 * Girth is measured at a representative station, not at the widest one: a
 * trunk's widest point is the root flare, which can be twice the radius of the
 * bole above it, and sizing the whole column from it tiled the bark at half
 * scale over every metre a player actually looks at.
 */
function barkMapping(part: SemanticTreePart): BarkMapping {
  const cached = barkMappingCache.get(part)
  if (cached) return cached
  const radii = part.spine.map((sample) =>
    Math.max(sample.crossSection.radiusX, sample.crossSection.radiusZ),
  )
  radii.sort((a, b) => a - b)
  const representative = radii[Math.floor(radii.length * 0.6)] ?? radii[0] ?? 0.05
  const circumference = Math.PI * 2 * Math.max(0.02, representative)
  const targetTile = BARK_TILE_METRES *
    clamp(representative / BARK_TILE_REFERENCE_RADIUS, BARK_TILE_MINIMUM_SCALE, 1)
  const repeats = Math.max(1, Math.round(circumference / targetTile))
  // Exact isotropy would hand a twig the tiny tile its own circumference
  // implies. Bounding how far the two axes may disagree keeps the stretch below
  // anything the eye reads as smearing while still killing the corrugation.
  const metresPerTile = clamp(
    circumference / repeats,
    targetTile / 1.5,
    targetTile * 1.5,
  )
  const mapping = { repeats, metresPerTile }
  barkMappingCache.set(part, mapping)
  return mapping
}

/**
 * Overrides a member's bark mapping.
 *
 * A continuation carries on through its parent's final ring, so it has to
 * inherit that ring's tile count *and* pick up its v where the parent left off.
 * Letting it size and phase its own mapping put a hard horizontal line across
 * the trunk at the exact height the bole handed over to the crown — the texture
 * jumping scale and offset in the middle of a continuous piece of wood.
 */
function inheritBarkMapping(
  part: SemanticTreePart,
  mapping: BarkMapping,
  origin: number,
): void {
  barkMappingCache.set(part, mapping)
  barkOriginCache.set(part, origin)
}

/**
 * Compiles spline-like semantic limbs directly into game topology. Unlike a
 * global voxel remesh, this preserves longitudinal edge flow, clean cross
 * sections, predictable budgets, and stable per-LOD topology.
 */
export function compileWoodyMesh(
  graph: SemanticTreeGraph,
  level: TreeLodLevel,
): { mesh: TreeMeshData; includedPartCount: number } {
  let qualityScale = 1
  let result = compileAtQuality(graph, level, qualityScale)

  // The budget is a contract. If an unusually dense recipe exceeds it, increase
  // geometric error and rebuild direct topology rather than decimating a giant
  // intermediate mesh.
  //
  // Eight attempts, not five. Five was enough while every recipe started within
  // a few per cent of the cap, and the ceiling is not what a dense one starts
  // at: a six-turn fused bole with a snapped crown compiles to about 155k
  // before any relief is applied, and each rebuild only takes a sixth off. It
  // used to run out at 112k and return it — over budget, silently, which is
  // the one thing a contract may not do. The extra rebuilds are build-time
  // work in a worker and only happen for recipes that need them.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const triangleCount = result.mesh.indices.length / 3
    if (triangleCount <= LOD_TRIANGLE_BUDGETS[level]) return result
    qualityScale *= Math.max(
      1.16,
      Math.sqrt(triangleCount / LOD_TRIANGLE_BUDGETS[level]) * 1.06,
    )
    result = compileAtQuality(graph, level, qualityScale)
  }
  return result
}

function compileAtQuality(
  graph: SemanticTreeGraph,
  level: TreeLodLevel,
  qualityScale: number,
): CompiledMesh {
  const settings = settingsFor(graph, level, qualityScale)
  const retained = retainedParts(graph.parts, settings, graph.bounds)
  const retainedIds = new Set(retained.map((part) => part.id))
  const partById = new Map(graph.parts.map((part) => [part.id, part]))
  const builder: MeshBuilder = { positions: [], colors: [], uvs: [], indices: [] }
  const paths = new Map<string, CompiledPath>()
  const endpoints = new Map<string, PartEndpoint>()

  for (const part of retained) {
    compilePart(
      builder,
      graph,
      part,
      partById,
      retainedIds,
      paths,
      endpoints,
      settings,
    )
  }

  const positions = Float32Array.from(builder.positions)
  const indices = Uint32Array.from(builder.indices)
  return {
    includedPartCount: retained.length,
    mesh: {
      positions,
      normals: computeSmoothNormals(positions, indices),
      colors: Float32Array.from(builder.colors),
      uvs: Float32Array.from(builder.uvs),
      indices,
      bounds: boundsOf(positions),
      geometricError: settings.geometricError,
    },
  }
}

function compilePart(
  builder: MeshBuilder,
  graph: SemanticTreeGraph,
  part: SemanticTreePart,
  partById: ReadonlyMap<string, SemanticTreePart>,
  retainedIds: ReadonlySet<string>,
  paths: Map<string, CompiledPath>,
  endpoints: Map<string, PartEndpoint>,
  settings: MeshSettings,
): void {
  const samples = adaptiveCurveSamples(part, settings)
  const parentPart = part.parentId ? partById.get(part.parentId) : undefined
  const inheritedEndpoint = parentPart ? endpoints.get(parentPart.id) : undefined
  const continuesParent = part.junctionType === 'continuation' && inheritedEndpoint
  // The child's own cross-section rotation is applied on top of its frame, so
  // the frame has to be seeded with the parent's vertex-zero direction rotated
  // *back* by that amount for the two rings to line up index for index.
  const phaseSeed = continuesParent && inheritedEndpoint
    ? rotateAroundAxis(
        inheritedEndpoint.vertexZero,
        samples[0]!.tangent,
        -samples[0]!.crossSection.rotation,
      )
    : undefined
  const frames = parallelTransportFrames(samples, phaseSeed)
  const path = { samples, frames }
  paths.set(part.id, path)
  // Distant LODs never get close enough for a fork to read, and the blend costs
  // a handful of distance queries per vertex on meshes that exist to be cheap.
  const neighbourhood = settings.level === 0
    ? junctionNeighbourhood(part, partById)
    : undefined

  const parent = parentPart
  const parentEndpoint = inheritedEndpoint
  const isContinuation = continuesParent
  let previous: Ring | undefined
  let finalRing: Ring | undefined

  if (isContinuation && parentEndpoint) {
    // A continuation carries on through the ring its parent ended with, so it
    // has to agree with the parent on how many sides that ring has. Letting it
    // size itself from its own girth left the two meshes butted together with
    // mismatched vertex counts and an open seam all the way round.
    if (parent && settings.level === 0) {
      const inherited = cachedRadialSegments(parent, settings)
      if (inherited !== undefined) setRadialSegments(part, settings, inherited)
    }
    // Same for the bark: inherit the parent's tile scale and pick its v up
    // where the parent left off, or the texture jumps scale and phase in the
    // middle of one continuous piece of wood.
    inheritBarkMapping(part, parentEndpoint.bark, parentEndpoint.barkV)
    previous = parentEndpoint.ring
    for (let index = 1; index < samples.length; index += 1) {
      const ring = createRing(
        builder,
        graph.seed,
        part,
        samples[index]!,
        frames[index]!,
        settings,
        1,
        neighbourhood,
      )
      connectRings(builder, previous, ring)
      previous = ring
    }
    finalRing = previous
  } else if (parent && paths.has(parent.id) && part.type !== 'trunk') {
    const attachment = attachmentFrame(paths.get(parent.id)!, part.attachment)
    const collar = collarStations(samples, frames, attachment)
    const rootCollar = part.type === 'root'
    const primaryFork = part.junctionType === 'bifurcation'
    if (part.embedded) {
      // A member whose opening rings are authored inside its parent. Hundreds
      // of adventitious palm roots begin inside the below-grade initiation
      // zone; a baobab's trunk-scale divisions originate inside the upper bole;
      // a dichotomy's daughters are as thick as the axis that made them. The
      // generic projected collar turns any of these into a circular shelf,
      // whereas leaving the first rings buried lets the shared junction blend
      // fuse the two exterior surfaces into one shoulder.
      for (let index = 0; index < samples.length; index += 1) {
        const ring = createRing(
          builder,
          graph.seed,
          part,
          samples[index]!,
          frames[index]!,
          settings,
          1,
          neighbourhood,
        )
        if (previous) connectRings(builder, previous, ring)
        else capStart(builder, ring, graph.seed, part)
        previous = ring
      }
    } else {
      const inner = createRing(
      builder,
      graph.seed,
      part,
      collar.inner.sample,
      collar.inner.frame,
      settings,
      rootCollar ? 0.38 : 0.28,
      )
      capStart(builder, inner, graph.seed, part)
      previous = inner

    const footprint = createRing(
      builder,
      graph.seed,
      part,
      collar.surface.sample,
      collar.surface.frame,
      settings,
      rootCollar ? 1.1 : primaryFork ? 1 : 1.08,
      neighbourhood,
      // Only vertices still *inside* the parent are lifted to its surface.
      // Outside vertices retain the child's round section, producing a local
      // saddle instead of either an intersecting pipe or a full-width skirt.
      attachment,
    )
    connectRings(builder, previous, footprint)
    previous = footprint

    if (collar.shoulder.sample.distance > collar.surface.sample.distance + 1e-5) {
      const ring = createRing(
        builder,
        graph.seed,
        part,
        collar.shoulder.sample,
        collar.shoulder.frame,
        settings,
        rootCollar ? 1.14 : primaryFork ? 1.01 : 1.07,
        neighbourhood,
      )
      connectRings(builder, previous, ring)
      previous = ring
    }
    if (
      collar.release.sample.distance >
      collar.shoulder.sample.distance + 1e-5
    ) {
      const ring = createRing(
        builder,
        graph.seed,
        part,
        collar.release.sample,
        collar.release.frame,
        settings,
        rootCollar ? 1.04 : primaryFork ? 1 : 1.025,
        neighbourhood,
      )
      connectRings(builder, previous, ring)
      previous = ring
    }

    for (let index = collar.remainingStart; index < samples.length; index += 1) {
      if (samples[index]!.distance <= collar.release.sample.distance + 1e-5) continue
      const ring = createRing(
        builder,
        graph.seed,
        part,
        samples[index]!,
        frames[index]!,
        settings,
        1,
        neighbourhood,
      )
      connectRings(builder, previous, ring)
      previous = ring
    }
    }
    finalRing = previous
  } else {
    for (let index = 0; index < samples.length; index += 1) {
      const ring = createRing(
        builder,
        graph.seed,
        part,
        samples[index]!,
        frames[index]!,
        settings,
        1,
        neighbourhood,
      )
      if (previous) connectRings(builder, previous, ring)
      else capStart(builder, ring, graph.seed, part)
      previous = ring
    }
    finalRing = previous
  }

  if (!finalRing) return
  if (
    settings.level === 0 &&
    part.type === 'trunk' &&
    samples.some((sample) => sample.crossSection.palmBootPhase !== undefined)
  ) {
    appendPalmBootPlates(builder, graph.seed, part, samples, frames)
  }
  const hasContinuation = part.continuationChildId
    ? retainedIds.has(part.continuationChildId)
    : false
  if (!hasContinuation) {
    if (
      part.junctionType === 'terminal' ||
      (part.id === 'leader' && part.age > 0.58)
    ) {
      capBrokenEnd(builder, finalRing, graph.seed, part)
    } else {
      capTaperedEnd(builder, finalRing, graph.seed, part)
    }
  }
  const finalSample = samples.at(-1)!
  const finalFrame = finalRing.frame
  const finalRotation = finalSample.crossSection.rotation
  endpoints.set(part.id, {
    ring: finalRing,
    sample: finalSample,
    vertexZero: normalize(add(
      multiply(finalFrame.x, Math.cos(finalRotation)),
      multiply(finalFrame.z, Math.sin(finalRotation)),
    ), finalFrame.x),
    bark: barkMapping(part),
    barkV: barkOrigin(part) +
      finalSample.distance / (barkMapping(part).metresPerTile * BARK_TILE_ASPECT),
  })
}

/**
 * Individual retained palm leaf bases embedded into the upper bole.
 *
 * A cross-section multiplier can only make a complete ring, which is why the
 * earlier palm trunk looked corrugated. These shallow five-sided wedges sit on
 * the actual swept surface, follow its transported frame, and can weather or
 * disappear independently in each phyllotactic rank.
 */
function appendPalmBootPlates(
  builder: MeshBuilder,
  seed: number,
  part: SemanticTreePart,
  samples: readonly CurveSample[],
  frames: readonly SweepFrame[],
): void {
  let previousRow = Number.NEGATIVE_INFINITY
  const firstBoot = samples.find((sample) => sample.crossSection.palmBootPhase !== undefined)
  // Coconut scars are interrupted annular ridges displaced directly in the
  // swept stipe. Separate phyllotactic boot plates belong to date/doum palms
  // and become conspicuous wooden spikes in a coconut crown.
  if (firstBoot?.crossSection.palmRinged) return
  const columns = Math.max(5, Math.round(firstBoot?.crossSection.palmBootRanks ?? 9))
  const maximumRow = Math.max(...samples.flatMap((sample) =>
    sample.crossSection.palmBootPhase === undefined
      ? []
      : [Math.floor(sample.crossSection.palmBootPhase)],
  ))
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex]!
    const phase = sample.crossSection.palmBootPhase
    if (phase === undefined) continue
    const row = Math.floor(phase)
    if (row === previousRow) continue
    previousRow = row
    // Mature lower bases have fused into the continuous stipe surface and are
    // represented by its displaced scar lips. Separate closed shells there
    // read as polygon chips glued to the trunk. Keep physical boots only in
    // the youngest crown-adjacent ranks where they genuinely project.
    if (row < maximumRow - 12) continue
    // The youngest two ranks are still live petiole sheaths buried within the
    // crown. Projecting a complete geometric rank at the terminal station made
    // their aligned top edges read as a horizontal wooden saucer.
    if (row >= maximumRow - 1) continue
    const frame = frames[sampleIndex]!
    const rowRetention = sample.crossSection.palmBootRetention ?? 0.7
    for (let column = 0; column < columns; column += 1) {
      const identity = hashUnit(seed + 12011, row, column, 0)
      if (identity > rowRetention) continue
      const stagger = (row % 2) * 0.5 +
        (hashUnit(seed + 13007, row, column, 0) - 0.5) * 0.18
      const angle = (column + stagger) / columns * Math.PI * 2
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      const outward = normalize(
        add(multiply(frame.x, cosine), multiply(frame.z, sine)),
        frame.x,
      )
      const side = normalize(cross(frame.tangent, outward), frame.x)
      const surface = add(
        sample.position,
        add(
          multiply(frame.x, cosine * sample.crossSection.radiusX),
          multiply(frame.z, sine * sample.crossSection.radiusZ),
        ),
      )
      const radius = Math.max(sample.crossSection.radiusX, sample.crossSection.radiusZ)
      const width = radius * (0.36 + identity * 0.1)
      const height = radius * (0.31 + identity * 0.1)
      const depth = radius * (
        0.006 + (sample.crossSection.palmBootRelief ?? 0) * (0.9 + identity)
      )
      const tilt = (hashUnit(seed + 14009, row, column, 0) - 0.5) * height * 0.18
      const axialOffset = (hashUnit(seed + 15013, row, column, 0) - 0.5) * height * 0.28
      const staggeredSurface = add(surface, multiply(frame.tangent, axialOffset))
      const frontCenter = add(staggeredSurface, multiply(outward, depth))
      const backCenter = add(staggeredSurface, multiply(outward, -radius * 0.035))
      const outline = [
        [-0.5, 0.38],
        [-0.5, 0.08],
        [-0.36, -0.2],
        [-0.1, -0.58],
        [0.1, -0.58],
        [0.36, -0.2],
        [0.5, 0.08],
        [0.5, 0.38],
      ] as const
      const colour = barkColor(frontCenter, part, seed)
      const front: number[] = []
      const back: number[] = []
      for (const [x, y] of outline) {
        const skewedY = y * height + x * tilt
        const u = (column + x + 0.5) / columns
        const v = ((row + y + 0.5) % 18 + 18) % 18 / 18
        front.push(appendPalmBootVertex(
          builder,
          add(frontCenter, add(multiply(side, x * width), multiply(frame.tangent, skewedY))),
          vec3(colour.x * 1.12, colour.y * 1.02, colour.z * 0.88),
          u,
          v,
        ))
        back.push(appendPalmBootVertex(
          builder,
          add(backCenter, add(multiply(side, x * width * 0.92), multiply(frame.tangent, skewedY * 0.92))),
          vec3(colour.x * 0.62, colour.y * 0.58, colour.z * 0.5),
          u,
          v,
        ))
      }
      // A shallow convex cut face catches a highlight across its fibrous lip;
      // a planar ngon reads as a flat shield glued onto the cylinder.
      const frontHub = appendPalmBootVertex(
        builder,
        add(frontCenter, multiply(outward, depth * (0.34 + identity * 0.22))),
        vec3(colour.x * 1.18, colour.y * 1.07, colour.z * 0.9),
        (column + 0.5) / columns,
        ((row + 0.5) % 18 + 18) % 18 / 18,
      )
      const backHub = appendPalmBootVertex(
        builder,
        backCenter,
        vec3(colour.x * 0.58, colour.y * 0.54, colour.z * 0.46),
        (column + 0.5) / columns,
        ((row + 0.5) % 18 + 18) % 18 / 18,
      )
      for (let triangle = 0; triangle < outline.length; triangle += 1) {
        const next = (triangle + 1) % outline.length
        builder.indices.push(
          frontHub, front[triangle]!, front[next]!,
          backHub, back[next]!, back[triangle]!,
        )
      }
      for (let edge = 0; edge < outline.length; edge += 1) {
        const next = (edge + 1) % outline.length
        builder.indices.push(
          front[edge]!, back[edge]!, back[next]!,
          front[edge]!, back[next]!, front[next]!,
        )
      }
    }
  }
}

function appendPalmBootVertex(
  builder: MeshBuilder,
  position: TreeVec3,
  colour: TreeVec3,
  u: number,
  v: number,
): number {
  const index = builder.positions.length / 3
  builder.positions.push(position.x, position.y, position.z)
  builder.colors.push(colour.x, colour.y, colour.z)
  builder.uvs.push(u, v)
  return index
}

function collarStations(
  samples: readonly CurveSample[],
  frames: readonly SweepFrame[],
  parent: AttachmentFrame,
): {
  inner: { sample: CurveSample; frame: SweepFrame }
  surface: { sample: CurveSample; frame: SweepFrame }
  shoulder: { sample: CurveSample; frame: SweepFrame }
  release: { sample: CurveSample; frame: SweepFrame }
  remainingStart: number
} {
  const first = samples[0]!
  const direction = first.tangent
  const xComponent = dot(direction, parent.x) / Math.max(1e-4, parent.radiusX)
  const zComponent = dot(direction, parent.z) / Math.max(1e-4, parent.radiusZ)
  const transverseRate = Math.hypot(xComponent, zComponent)
  const totalDistance = samples.at(-1)!.distance
  const surfaceDistance = clamp(
    transverseRate > 1e-5 ? 1 / transverseRate : Math.max(parent.radiusX, parent.radiusZ),
    0,
    totalDistance * 0.32,
  )
  const baseRadius = Math.max(
    first.crossSection.radiusX,
    first.crossSection.radiusZ,
  )
  // On a thick or strongly lobed parent, one child radius is not safely
  // internal: the oblique start cap still cuts through the near surface as a
  // visible hook or circular wound. Start more than two radii back so every
  // cap vertex and the first transition triangles remain inside shared wood.
  const innerDistance = Math.max(0, surfaceDistance - baseRadius * 2.15)
  const shoulderDistance = Math.min(totalDistance, surfaceDistance + baseRadius * 0.52)
  const releaseDistance = Math.min(totalDistance, surfaceDistance + baseRadius * 1.45)

  const inner = samplePathAtDistance(samples, frames, innerDistance)
  const surface = samplePathAtDistance(samples, frames, surfaceDistance)
  const shoulder = samplePathAtDistance(samples, frames, shoulderDistance)
  const release = samplePathAtDistance(samples, frames, releaseDistance)
  let remainingStart = 0
  while (
    remainingStart < samples.length &&
    samples[remainingStart]!.distance <= releaseDistance + 1e-5
  ) {
    remainingStart += 1
  }
  return { inner, surface, shoulder, release, remainingStart }
}

function samplePathAtDistance(
  samples: readonly CurveSample[],
  frames: readonly SweepFrame[],
  distance: number,
): { sample: CurveSample; frame: SweepFrame } {
  if (distance <= 0) return { sample: samples[0]!, frame: frames[0]! }
  const last = samples.length - 1
  if (distance >= samples[last]!.distance) {
    return { sample: samples[last]!, frame: frames[last]! }
  }
  let right = 1
  while (right < samples.length && samples[right]!.distance < distance) right += 1
  const left = right - 1
  const a = samples[left]!
  const b = samples[right]!
  const amount = (distance - a.distance) / Math.max(1e-6, b.distance - a.distance)
  const tangent = normalize(lerp(a.tangent, b.tangent, amount), a.tangent)
  const x = normalize(
    subtract(lerp(frames[left]!.x, frames[right]!.x, amount), multiply(tangent, dot(lerp(frames[left]!.x, frames[right]!.x, amount), tangent))),
    frames[left]!.x,
  )
  return {
    sample: {
      position: lerp(a.position, b.position, amount),
      tangent,
      crossSection: interpolateCrossSection(a.crossSection, b.crossSection, amount),
      burialDepth: lerpNumber(a.burialDepth, b.burialDepth, amount),
      distance,
    },
    frame: { tangent, x, z: normalize(cross(x, tangent), frames[left]!.z) },
  }
}

function attachmentFrame(path: CompiledPath, attachment: number): AttachmentFrame {
  const distance = path.samples.at(-1)!.distance * clamp(attachment, 0, 1)
  const { sample, frame } = samplePathAtDistance(path.samples, path.frames, distance)
  const rotation = sample.crossSection.rotation
  const cosine = Math.cos(rotation)
  const sine = Math.sin(rotation)
  return {
    center: sample.position,
    tangent: sample.tangent,
    x: normalize(add(multiply(frame.x, cosine), multiply(frame.z, sine)), frame.x),
    z: normalize(add(multiply(frame.x, -sine), multiply(frame.z, cosine)), frame.z),
    radiusX: sample.crossSection.radiusX,
    radiusZ: sample.crossSection.radiusZ,
    fins: sample.crossSection.fins,
  }
}

function adaptiveCurveSamples(
  part: SemanticTreePart,
  settings: MeshSettings,
): CurveSample[] {
  const tolerance = settings.geometricError * (
    part.type === 'trunk' ? 0.36 : part.type === 'root' ? 0.46 : 0.56
  )
  // Hero palm boots are axial silhouette events, not curve noise. The generic
  // Douglas-Peucker pass only compares centreline and radius, so it otherwise
  // deletes every retained leaf-base row before the ring builder can see it.
  const meshPalmBoots = settings.level === 0 &&
    part.spine.some((sample) => sample.crossSection.palmBootPhase !== undefined)
  const spine = meshPalmBoots
    ? part.spine.map(cloneSpineSample)
    : simplifySpine(part.spine, tolerance)
  const targetStep = settings.targetStep * (
    part.type === 'trunk' ? 0.78 : part.type === 'root' ? 0.88 : part.type === 'twig' ? 1.16 : 1
  )
  const provisional: Omit<CurveSample, 'tangent' | 'distance'>[] = []

  for (let segment = 0; segment < spine.length - 1; segment += 1) {
    const a = spine[segment]!
    const b = spine[segment + 1]!
    const segmentVector = subtract(b.position, a.position)
    const segmentLength = length(segmentVector)
    const previousDirection = segment > 0
      ? normalize(subtract(a.position, spine[segment - 1]!.position))
      : normalize(segmentVector)
    const nextDirection = segment + 2 < spine.length
      ? normalize(subtract(spine[segment + 2]!.position, b.position))
      : normalize(segmentVector)
    const localTurn = Math.max(
      Math.acos(clamp(dot(previousDirection, normalize(segmentVector)), -1, 1)),
      Math.acos(clamp(dot(normalize(segmentVector), nextDirection), -1, 1)),
    )
    // Ring spacing also has to respect the member's own girth. A tube whose
    // rings are five radii apart triangulates into long thin quads, and their
    // diagonals read as a sawtooth running along every curved limb — the
    // "diamond stepping" visual review kept finding on crown wood. Three radii
    // is close enough to square that the diagonal disappears.
    const girth = Math.max(
      0.02,
      Math.min(
        Math.max(a.crossSection.radiusX, a.crossSection.radiusZ),
        Math.max(b.crossSection.radiusX, b.crossSection.radiusZ),
      ),
    )
    // Twigs are exempt: they are a pixel or two wide, nobody sees a diagonal on
    // them, and they outnumber the limbs several hundred to one — capping their
    // spacing doubles a hero mesh and spends the budget where it cannot show.
    const girthStep = part.type === 'twig' || settings.level > 0
      ? Infinity
      : girth * 3.2
    // Ring spacing from how fast the member's *radius* changes, which is a
    // separate question from how fast its centreline turns.
    //
    // Every rule above measures the centreline: how far it has travelled, how
    // sharply it bends, how thick it is. A root flare defeats all three at
    // once. It is straight, so `maximumTurn` never fires; it is the thickest
    // part of the tree, so `girthStep` goes wide rather than narrow; and it is
    // short, so `targetStep` gives it a single ring. The result was a buttress
    // meshed as one cone frustum — a hard crease where a swelling profile
    // should be, on the one part of a tree a person standing in the forest is
    // always within arm's reach of.
    const taperDelta = Math.abs(
      Math.max(b.crossSection.radiusX, b.crossSection.radiusZ) -
      Math.max(a.crossSection.radiusX, a.crossSection.radiusZ),
    )
    const taperSteps = settings.level === 0
      ? Math.ceil(taperDelta / Math.max(0.035, settings.geometricError * 1.5))
      : 1
    const subdivisions = clamp(
      Math.max(
        1,
        Math.ceil(segmentLength / Math.max(0.08, Math.min(targetStep, girthStep))),
        Math.ceil(localTurn / settings.maximumTurn),
        taperSteps,
      ),
      1,
      settings.level === 0 ? 14 : 10,
    )
    const tangentA = multiply(
      normalize(
        subtract(
          b.position,
          spine[Math.max(0, segment - 1)]!.position,
        ),
        normalize(segmentVector),
      ),
      segmentLength * 0.82,
    )
    const tangentB = multiply(
      normalize(
        subtract(
          spine[Math.min(spine.length - 1, segment + 2)]!.position,
          a.position,
        ),
        normalize(segmentVector),
      ),
      segmentLength * 0.82,
    )

    for (let step = 0; step < subdivisions; step += 1) {
      const amount = step / subdivisions
      provisional.push({
        position: hermite(a.position, b.position, tangentA, tangentB, amount),
        crossSection: interpolateCrossSection(a.crossSection, b.crossSection, amount),
        burialDepth: lerpNumber(a.burialDepth, b.burialDepth, amount),
      })
    }
  }
  const last = spine.at(-1)!
  provisional.push({
    position: { ...last.position },
    crossSection: { ...last.crossSection },
    burialDepth: last.burialDepth,
  })

  const result: CurveSample[] = []
  let distance = 0
  for (let index = 0; index < provisional.length; index += 1) {
    const current = provisional[index]!
    if (index > 0) distance += length(subtract(current.position, provisional[index - 1]!.position))
    const tangent = normalize(
      subtract(
        provisional[Math.min(provisional.length - 1, index + 1)]!.position,
        provisional[Math.max(0, index - 1)]!.position,
      ),
      vec3(0, 1, 0),
    )
    result.push({ ...current, tangent, distance })
  }
  return result
}

function simplifySpine(
  spine: readonly TreeSpineSample[],
  tolerance: number,
): TreeSpineSample[] {
  if (spine.length <= 2) return spine.map(cloneSpineSample)
  const keep = new Uint8Array(spine.length)
  keep[0] = 1
  keep[spine.length - 1] = 1
  const stack: Array<[number, number]> = [[0, spine.length - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop()!
    const a = spine[start]!
    const b = spine[end]!
    let maximumError = -1
    let maximumIndex = -1
    for (let index = start + 1; index < end; index += 1) {
      const amount = projectAmount(spine[index]!.position, a.position, b.position)
      const projected = lerp(a.position, b.position, amount)
      const positionError = length(subtract(spine[index]!.position, projected))
      const expectedRadius = lerpNumber(a.radius, b.radius, amount)
      const radiusError = Math.abs(spine[index]!.radius - expectedRadius) * 0.72
      const error = Math.max(positionError, radiusError)
      if (error > maximumError) {
        maximumError = error
        maximumIndex = index
      }
    }
    if (maximumError > tolerance && maximumIndex > start) {
      keep[maximumIndex] = 1
      stack.push([start, maximumIndex], [maximumIndex, end])
    }
  }
  return spine.filter((_, index) => keep[index] === 1).map(cloneSpineSample)
}

function cloneSpineSample(sample: TreeSpineSample): TreeSpineSample {
  return {
    position: { ...sample.position },
    radius: sample.radius,
    burialDepth: sample.burialDepth,
    crossSection: { ...sample.crossSection },
  }
}

function projectAmount(point: TreeVec3, a: TreeVec3, b: TreeVec3): number {
  const direction = subtract(b, a)
  const denominator = dot(direction, direction)
  return denominator > 1e-9
    ? clamp(dot(subtract(point, a), direction) / denominator, 0, 1)
    : 0
}

function hermite(
  a: TreeVec3,
  b: TreeVec3,
  tangentA: TreeVec3,
  tangentB: TreeVec3,
  amount: number,
): TreeVec3 {
  const t2 = amount * amount
  const t3 = t2 * amount
  return add(
    add(
      multiply(a, 2 * t3 - 3 * t2 + 1),
      multiply(tangentA, t3 - 2 * t2 + amount),
    ),
    add(
      multiply(b, -2 * t3 + 3 * t2),
      multiply(tangentB, t3 - t2),
    ),
  )
}

function interpolateCrossSection(
  a: TreeCrossSection,
  b: TreeCrossSection,
  amount: number,
): TreeCrossSection {
  return {
    radiusX: lerpNumber(a.radiusX, b.radiusX, amount),
    radiusZ: lerpNumber(a.radiusZ, b.radiusZ, amount),
    rotation: lerpNumber(a.rotation, b.rotation, amount),
    lobeCount: amount < 0.5 ? a.lobeCount : b.lobeCount,
    lobeStrength: lerpNumber(a.lobeStrength, b.lobeStrength, amount),
    palmBootPhase: a.palmBootPhase === undefined || b.palmBootPhase === undefined
      ? a.palmBootPhase ?? b.palmBootPhase
      : lerpNumber(a.palmBootPhase, b.palmBootPhase, amount),
    palmRinged: amount < 0.5 ? a.palmRinged : b.palmRinged,
    palmBootRelief: lerpNumber(a.palmBootRelief ?? 0, b.palmBootRelief ?? 0, amount),
    palmBootRanks: amount < 0.5 ? a.palmBootRanks : b.palmBootRanks,
    palmBootRetention: lerpNumber(
      a.palmBootRetention ?? 0,
      b.palmBootRetention ?? 0,
      amount,
    ),
    fins: interpolateButtressFins(a.fins, b.fins, amount),
    fusedStems: interpolateFusedStems(a.fusedStems, b.fusedStems, amount),
    fusedStemBlend: lerpNumber(a.fusedStemBlend ?? 0, b.fusedStemBlend ?? 0, amount),
  }
}

function interpolateButtressFins(
  a: readonly TreeButtressFin[] | undefined,
  b: readonly TreeButtressFin[] | undefined,
  amount: number,
): readonly TreeButtressFin[] | undefined {
  if (!a && !b) return undefined
  const count = Math.max(a?.length ?? 0, b?.length ?? 0)
  const fins: TreeButtressFin[] = []
  for (let index = 0; index < count; index += 1) {
    const left = a?.[index] ?? b?.[index]
    const right = b?.[index] ?? a?.[index]
    if (!left || !right) continue
    fins.push({
      direction: normalize(lerp(left.direction, right.direction, amount), left.direction),
      strength: lerpNumber(a?.[index]?.strength ?? 0, b?.[index]?.strength ?? 0, amount),
      width: lerpNumber(left.width, right.width, amount),
    })
  }
  return fins
}

export function parallelTransportFrames(
  samples: readonly CurveSample[],
  seedX?: TreeVec3,
): SweepFrame[] {
  const frames: SweepFrame[] = []
  const firstTangent = samples[0]!.tangent
  const reference = Math.abs(firstTangent.y) < 0.82 ? vec3(0, 1, 0) : vec3(0, 0, 1)
  // A seeded frame carries a parent's angular phase across a continuation. It
  // is projected onto the child's own normal plane, so an inherited direction
  // that is no longer perpendicular still yields a valid orthonormal frame.
  const seeded = seedX
    ? subtract(seedX, multiply(firstTangent, dot(seedX, firstTangent)))
    : undefined
  let x = seeded && dot(seeded, seeded) > 1e-8
    ? normalize(seeded)
    : normalize(cross(reference, firstTangent), vec3(1, 0, 0))
  let z = normalize(cross(x, firstTangent), vec3(0, 0, 1))
  frames.push({ tangent: firstTangent, x, z })

  for (let index = 1; index < samples.length; index += 1) {
    const previousTangent = samples[index - 1]!.tangent
    const tangent = samples[index]!.tangent
    const rotationAxis = cross(previousTangent, tangent)
    const sine = length(rotationAxis)
    if (sine > 1e-7) {
      const axis = multiply(rotationAxis, 1 / sine)
      const angle = Math.atan2(sine, clamp(dot(previousTangent, tangent), -1, 1))
      x = rotateAroundAxis(x, axis, angle)
    }
    x = normalize(subtract(x, multiply(tangent, dot(x, tangent))), x)
    z = normalize(cross(x, tangent), z)
    frames.push({ tangent, x, z })
  }
  return frames
}

function rotateAroundAxis(value: TreeVec3, axis: TreeVec3, angle: number): TreeVec3 {
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return add(
    add(multiply(value, cosine), multiply(cross(axis, value), sine)),
    multiply(axis, dot(axis, value) * (1 - cosine)),
  )
}

function createRing(
  builder: MeshBuilder,
  seed: number,
  part: SemanticTreePart,
  sample: CurveSample,
  frame: SweepFrame,
  settings: MeshSettings,
  radiusScale: number,
  neighbourhood?: JunctionNeighbourhood,
  projectToParent?: AttachmentFrame,
): Ring {
  // Fixed for the whole part at the hero LOD. Choosing it per ring meant
  // neighbouring rings could disagree on how many sides they had, and the
  // stitch between them sheared the bark sideways — a visible horizontal band
  // across the trunk at every change. A handful of extra triangles on the thin
  // end is far cheaper than a seam at eye height. The distant LODs keep the
  // per-ring count: nothing there is close enough for the seam to read, and
  // their budgets have no room for carrying a trunk's girth out to the twigs.
  const radialSegments = settings.level === 0
    ? partRadialSegments(part, settings, radiusScale)
    : radialSegmentsFor(
        sample.crossSection.radiusX,
        sample.crossSection.radiusZ,
        part,
        settings,
        radiusScale,
      )
  const indices: number[] = []
  const positions: TreeVec3[] = []
  for (let segment = 0; segment < radialSegments; segment += 1) {
    const angle = (segment / radialSegments) * Math.PI * 2
    const rotation = sample.crossSection.rotation
    const rotatedAngle = angle + rotation
    const lobeCount = Math.max(1, sample.crossSection.lobeCount)
    const lobePhase = hashUnit(
      seed + part.branchOrder * 7907,
      part.age,
      lobeCount,
      part.vigor,
    ) * Math.PI * 2
    const lobeWave =
      Math.cos(angle * lobeCount + lobePhase) * 0.72 +
      Math.cos(angle * Math.max(1, lobeCount - 2) - lobePhase * 0.63) * 0.2 +
      Math.sin(angle * (lobeCount + 1) + lobePhase * 0.31) * 0.08
    // A fused column's outline is the union of its stems, not a rippled circle.
    // Where one is authored it replaces the harmonic term outright: adding a
    // cosine on top of a real union only makes the folds noisy.
    const fused = sample.crossSection.fusedStems
    const lobe = fused && fused.length > 0
      ? fusedStemRadius(
          fused,
          Math.cos(rotatedAngle),
          Math.sin(rotatedAngle),
          sample.crossSection.fusedStemBlend ?? 0.08,
        ) || 1
      : 1 + sample.crossSection.lobeStrength * lobeWave
    const ridge = settings.level === 0
      ? 1 +
        Math.sin(angle * 11 + sample.distance * 0.9 + part.branchOrder) * 0.008 +
        Math.sin(angle * 5 - sample.distance * 0.34 + part.age * 3.1) *
          part.age * 0.012
      : 1
    // Fins are evaluated against the vertex's own *world* direction, not
    // against its angle in the sweep frame. The frame is parallel-transported
    // and its zero can point anywhere, so an angle-space fin would drift around
    // the trunk as the frame twisted and stop lining up with the root it is
    // supposed to be running out to.
    const outward = add(
      multiply(frame.x, Math.cos(rotatedAngle)),
      multiply(frame.z, Math.sin(rotatedAngle)),
    )
    const buttress = finSwell(sample.crossSection.fins, outward)
    const palmBoot = palmBootSwell(sample.crossSection, angle, seed)
    const swell = lobe * ridge * buttress * palmBoot
    const localX = Math.cos(rotatedAngle) * sample.crossSection.radiusX * radiusScale * swell
    const localZ = Math.sin(rotatedAngle) * sample.crossSection.radiusZ * radiusScale * swell
    let position = add(
      sample.position,
      add(multiply(frame.x, localX), multiply(frame.z, localZ)),
    )
    if (projectToParent) position = projectOntoParentSurface(position, projectToParent)
    // Fuse the union before the vertex is committed, so the fillet participates
    // in the smooth normals and the arc-length bark mapping rather than being a
    // separate patch stitched over the seam afterwards.
    if (neighbourhood) {
      position = applyJunctionBlend(
        position,
        outward,
        Math.hypot(localX, localZ),
        neighbourhood,
      )
    }
    indices.push(builder.positions.length / 3)
    positions.push(position)
    builder.positions.push(position.x, position.y, position.z)
    // Arc-length UVs, rounded to a whole number of tiles around the member.
    // Mapping u straight to 0..1 gave a two-metre trunk the same texture budget
    // as a finger-thick twig, so bark grain was six times coarser on the one
    // surface the camera gets closest to.
    // The angular term carries the cross-section's own rotation. Without it the
    // geometry twists along the member while the texture does not, and the bark
    // shears diagonally across every gnarled trunk.
    builder.uvs.push(
      (segment / radialSegments + rotation / (Math.PI * 2)) *
        barkMapping(part).repeats,
      sample.distance /
        (barkMapping(part).metresPerTile * BARK_TILE_ASPECT) +
        barkOrigin(part),
    )
    const color = barkColor(position, part, seed)
    builder.colors.push(color.x, color.y, color.z)
  }
  return { indices, positions, center: sample.position, frame }
}

/** Localised staggered leaf-base lips baked into the hero palm silhouette. */
function palmBootSwell(
  crossSection: TreeCrossSection,
  angle: number,
  seed: number,
): number {
  const phase = crossSection.palmBootPhase
  const relief = crossSection.palmBootRelief ?? 0
  if (phase === undefined || relief <= 0) return 1
  const row = Math.floor(phase)
  const localY = phase - row
  if (crossSection.palmRinged) {
    const segments = 13
    const across = angle / (Math.PI * 2) * segments
    const segment = Math.floor(across)
    const identity = hashUnit(seed + 6271, segment, row, 0)
    const missing = hashUnit(seed + 8819, segment, row, 0) < 0.15
    const lipY = 0.5 + (identity - 0.5) * 0.13
    const lip = Math.exp(-Math.pow((localY - lipY) / 0.07, 2))
    return 1 + relief * lip * (missing ? 0.08 : 0.72 + identity * 0.42)
  }
  const columns = 8
  const stagger = (row % 2) * 0.5 +
    (hashUnit(seed + 1907, row, 0, 0) - 0.5) * 0.22
  const across = angle / (Math.PI * 2) * columns + stagger
  const column = Math.floor(across)
  const localX = across - column
  const identity = hashUnit(seed + 6271, column, row, 0)
  const lipY = 0.3 + (identity - 0.5) * 0.09 +
    Math.abs(localX - 0.5) * (0.42 + identity * 0.12)
  const distance = Math.abs(localY - lipY)
  const lip = Math.exp(-Math.pow(distance / 0.075, 2))
  const worn = hashUnit(seed + 8819, column, row, 0) < 0.2 ? 0.24 : 1
  return 1 + relief * lip * worn * (0.7 + identity * 0.38)
}

const radialSegmentCache = new WeakMap<SemanticTreePart, Map<number, number>>()

function partRadialSegments(
  part: SemanticTreePart,
  settings: MeshSettings,
  radiusScale: number,
): number {
  const cached = cachedRadialSegments(part, settings)
  if (cached !== undefined) return cached
  // Sized from the part's thick end, since that is where facets show.
  const widest = part.spine.reduce(
    (maximum, sample) => Math.max(
      maximum,
      sample.crossSection.radiusX,
      sample.crossSection.radiusZ,
    ),
    0,
  )
  const segments = radialSegmentsFor(widest, widest, part, settings, radiusScale)
  setRadialSegments(part, settings, segments)
  return segments
}

function cachedRadialSegments(
  part: SemanticTreePart,
  settings: MeshSettings,
): number | undefined {
  return radialSegmentCache.get(part)?.get(settings.level)
}

function setRadialSegments(
  part: SemanticTreePart,
  settings: MeshSettings,
  segments: number,
): void {
  let byLevel = radialSegmentCache.get(part)
  if (!byLevel) {
    byLevel = new Map()
    radialSegmentCache.set(part, byLevel)
  }
  byLevel.set(settings.level, segments)
}

/**
 * Radial multiplier from the buttress ribs at this station.
 *
 * A raised cosine over the angle between the vertex and the rib, so each rib is
 * a rounded ridge with a smooth valley either side rather than a spike. Ribs
 * add, which is what lets two roots leaving close together merge into one broad
 * plate the way they actually do.
 */
function finSwell(
  fins: readonly TreeButtressFin[] | undefined,
  outward: TreeVec3,
): number {
  if (!fins || fins.length === 0) return 1
  const horizontal = normalize(vec3(outward.x, 0, outward.z), vec3(1, 0, 0))
  let swell = 1
  for (const fin of fins) {
    const alignment = clamp(dot(horizontal, fin.direction), -1, 1)
    const offset = Math.acos(alignment) / Math.max(1e-3, fin.width)
    if (offset >= 1) continue
    swell += fin.strength * (0.5 + 0.5 * Math.cos(offset * Math.PI))
  }
  return swell
}

function radialSegmentsFor(
  crossRadiusX: number,
  crossRadiusZ: number,
  part: SemanticTreePart,
  settings: MeshSettings,
  radiusScale: number,
): number {
  const radiusX = crossRadiusX * radiusScale
  const radiusZ = crossRadiusZ * radiusScale
  const circumference = Math.PI * 2 * Math.sqrt((radiusX * radiusX + radiusZ * radiusZ) * 0.5)
  const targetEdge = settings.geometricError * 2.05
  // Tiny terminal twigs do not benefit from the same eight-sided floor as a
  // hero trunk. Four-sided carriers shade smoothly at their screen size and
  // preserve the triangle budget for the visible trunk, unions, and scaffolds.
  // Six sides on a twig and ten on a limb. Four-sided carriers were meant to
  // save budget for the trunk, but a raking sun turns a four-sided tube into a
  // visibly polygonal ribbon, and the crown is mostly made of these.
  // Six sides on a hero twig: four-sided carriers were meant to save budget for
  // the trunk, but a raking sun turns a four-sided tube into a visibly
  // polygonal ribbon and the crown is mostly made of these. The distant LODs
  // drop back down — nothing there is more than a few pixels across.
  let minimum = part.type === 'twig'
    ? settings.level === 0 ? 6 : settings.level === 1 ? 4 : 3
    : settings.minimumRadial
  if (part.type === 'trunk') minimum += settings.level === 0 ? 6 : settings.level === 1 ? 2 : 0
  // Roots are the one member a player is routinely within a metre of, and their
  // cross section is the least circular in the tree, so they need the most
  // sides to avoid reading as a folded strip of card.
  else if (part.type === 'root' && settings.level === 0) minimum += 6
  const lobeStrength = part.spine.reduce(
    (maximum, entry) => Math.max(maximum, entry.crossSection.lobeStrength),
    0,
  )
  if (lobeStrength > 0.045) {
    minimum = Math.max(minimum, (part.spine[0]?.crossSection.lobeCount ?? 3) * 2)
  }
  for (const entry of part.spine) {
    const fused = entry.crossSection.fusedStems
    if (fused && fused.length > 0) {
      minimum = Math.max(minimum, fusedStemSegments(fused))
      break
    }
  }
  // A rib narrower than the ring's angular step simply is not there. Sized from
  // the narrowest rib on the member so the valleys between them stay sharp.
  let narrowestFin = Infinity
  for (const entry of part.spine) {
    for (const fin of entry.crossSection.fins ?? []) {
      if (fin.strength > 0.05) narrowestFin = Math.min(narrowestFin, fin.width)
    }
  }
  if (Number.isFinite(narrowestFin)) {
    minimum = Math.max(minimum, Math.ceil((Math.PI * 2) / narrowestFin) * 2)
  }
  // Everything above says what this member *wants*. The relief says what the
  // budget can afford, and it is 1 unless a rebuild is already under way.
  const relief = settings.radialRelief
  const affordable = Math.max(4, Math.round(minimum * relief))
  const requested = clamp(
    Math.ceil(circumference / Math.max(0.08, targetEdge)),
    affordable,
    Math.max(affordable, Math.round(settings.maximumRadial * relief)),
  )
  const floor = Math.max(
    3,
    Math.round(
      (part.type === 'twig'
        ? settings.level === 0 ? 6 : 3
        : settings.level === 2 ? 5 : 8) * relief,
    ),
  )
  return Math.max(floor, requested + (requested % 2))
}

function projectOntoParentSurface(
  position: TreeVec3,
  parent: AttachmentFrame,
): TreeVec3 {
  const delta = subtract(position, parent.center)
  const axialDistance = dot(delta, parent.tangent)
  const radial = subtract(delta, multiply(parent.tangent, axialDistance))
  let x = dot(radial, parent.x)
  let z = dot(radial, parent.z)
  const ellipseLength = Math.hypot(
    x / Math.max(1e-4, parent.radiusX),
    z / Math.max(1e-4, parent.radiusZ),
  )
  // The outside half of the collar is already the correct child surface.
  // Projecting it back to the parent is what stretched thick branches into
  // horizontal plates around a bole. Only fill the penetrating half.
  if (ellipseLength >= 1) return position
  if (ellipseLength < 1e-5) {
    x = parent.radiusX
    z = 0
  } else {
    x /= ellipseLength
    z /= ellipseLength
  }
  // The ellipse is only the bole under the buttress ribs. Projecting a root's
  // collar onto that hidden inner cylinder makes it tunnel through the fin and
  // pop out as a separate tube. Use the same directional swell as the actual
  // parent ring so the collar lands on the visible rib it continues.
  const swell = finSwell(parent.fins, radial)
  x *= swell
  z *= swell
  return add(
    add(parent.center, multiply(parent.tangent, axialDistance)),
    add(multiply(parent.x, x), multiply(parent.z, z)),
  )
}

function connectRings(builder: MeshBuilder, a: Ring, b: Ring): void {
  const countA = a.indices.length
  const countB = b.indices.length
  let indexA = 0
  let indexB = 0
  while (indexA < countA || indexB < countB) {
    const nextA = (indexA + 1) / countA
    const nextB = (indexB + 1) / countB
    const a0 = a.indices[indexA % countA]!
    const b0 = b.indices[indexB % countB]!
    if (Math.abs(nextA - nextB) < 1e-9) {
      const a1 = a.indices[(indexA + 1) % countA]!
      const b1 = b.indices[(indexB + 1) % countB]!
      builder.indices.push(a0, b0, b1, a0, b1, a1)
      indexA += 1
      indexB += 1
    } else if (nextA < nextB) {
      const a1 = a.indices[(indexA + 1) % countA]!
      builder.indices.push(a0, b0, a1)
      indexA += 1
    } else {
      const b1 = b.indices[(indexB + 1) % countB]!
      builder.indices.push(a0, b0, b1)
      indexB += 1
    }
  }
}

function capStart(
  builder: MeshBuilder,
  ring: Ring,
  seed: number,
  part: SemanticTreePart,
): void {
  const averageRadius = averageRingRadius(ring)
  const center = subtract(ring.center, multiply(ring.frame.tangent, averageRadius * 0.08))
  const centerIndex = appendVertex(builder, center, barkColor(center, part, seed))
  for (let index = 0; index < ring.indices.length; index += 1) {
    builder.indices.push(
      centerIndex,
      ring.indices[index]!,
      ring.indices[(index + 1) % ring.indices.length]!,
    )
  }
}

function capTaperedEnd(
  builder: MeshBuilder,
  ring: Ring,
  seed: number,
  part: SemanticTreePart,
): void {
  const averageRadius = averageRingRadius(ring)
  const tip = add(ring.center, multiply(ring.frame.tangent, Math.max(0.035, averageRadius * 1.35)))
  const tipIndex = appendVertex(builder, tip, barkColor(tip, part, seed))
  for (let index = 0; index < ring.indices.length; index += 1) {
    builder.indices.push(
      tipIndex,
      ring.indices[(index + 1) % ring.indices.length]!,
      ring.indices[index]!,
    )
  }
}

function capBrokenEnd(
  builder: MeshBuilder,
  ring: Ring,
  seed: number,
  part: SemanticTreePart,
): void {
  const averageRadius = averageRingRadius(ring)
  const center = add(
    ring.center,
    multiply(ring.frame.tangent, Math.max(0.01, averageRadius * 0.08)),
  )
  const bark = barkColor(center, part, seed)
  const exposedWood = vec3(
    Math.min(1, bark.x * 1.18),
    Math.min(1, bark.y * 1.1),
    Math.min(1, bark.z * 0.92),
  )
  const centerIndex = appendVertex(builder, center, exposedWood)
  for (let index = 0; index < ring.indices.length; index += 1) {
    builder.indices.push(
      centerIndex,
      ring.indices[(index + 1) % ring.indices.length]!,
      ring.indices[index]!,
    )
  }
}

function averageRingRadius(ring: Ring): number {
  let total = 0
  for (const position of ring.positions) total += length(subtract(position, ring.center))
  return total / Math.max(1, ring.positions.length)
}

function appendVertex(
  builder: MeshBuilder,
  position: TreeVec3,
  color: TreeVec3,
): number {
  const index = builder.positions.length / 3
  builder.positions.push(position.x, position.y, position.z)
  builder.colors.push(color.x, color.y, color.z)
  builder.uvs.push(0.5, 0.5)
  return index
}

/**
 * Trilinearly interpolated value noise over the shared lattice hash.
 *
 * `hashUnit` is a lattice function: it floors its inputs, so it is only
 * smooth if it is sampled on integers and interpolated between them. Sampling
 * it at raw world positions — which several callers used to do — gives white
 * noise at vertex frequency, which is not what any of them wanted.
 */
function smoothNoise3(seed: number, x: number, y: number, z: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const ux = smoothstepUnit(x - xi)
  const uy = smoothstepUnit(y - yi)
  const uz = smoothstepUnit(z - zi)
  let total = 0
  for (let dz = 0; dz < 2; dz += 1) {
    const wz = dz === 1 ? uz : 1 - uz
    for (let dy = 0; dy < 2; dy += 1) {
      const wy = dy === 1 ? uy : 1 - uy
      for (let dx = 0; dx < 2; dx += 1) {
        const wx = dx === 1 ? ux : 1 - ux
        total += wx * wy * wz * hashUnit(seed, xi + dx, yi + dy, zi + dz)
      }
    }
  }
  return total
}

function smoothstepUnit(t: number): number {
  return t * t * (3 - 2 * t)
}

function barkColor(
  position: TreeVec3,
  part: SemanticTreePart,
  seed: number,
): TreeVec3 {
  // Bark belongs to the whole organism. Re-seeding tint from `part.id` made a
  // trunk change colour and moss pattern at the exact ring where its semantic
  // leader began, even though the geometry and UVs were continuous. A seeded
  // world-space field remains deterministic and varied while crossing every
  // continuation and collar without a material boundary.
  // Smooth fields, not per-vertex hashes.
  //
  // `hashUnit` quantises its inputs to 1/8192, so sampling it at a vertex
  // position returns an independent random number for every vertex however low
  // the frequency multiplier looks. Interpolated across the faces between them
  // that is not a tint, it is a Gouraud patchwork keyed to the mesh: a wall of
  // flat polygons whose size tracks the tessellation rather than anything
  // about the bark. It was the single loudest "cheap procedural" tell on a
  // trunk — and because it lives in the vertex colours it survived every
  // change to the baked bark tile, which is what made it so hard to find.
  const variation = smoothNoise3(seed, position.x * 1.7, position.y * 0.85, position.z * 1.7)
  const verticalGrain = 0.5 + 0.5 * Math.sin(position.y * 2.4 + position.x * 0.7 - position.z * 0.55)
  const mossNoise = smoothNoise3(
    seed + 9173,
    position.x * 0.6,
    position.y * 0.42,
    position.z * 0.6,
  )
  const moss = part.age * clamp((mossNoise - 0.54) * 2.8, 0, 1) *
    (part.type === 'twig' ? 0.35 : 1)
  const rootDarkening = part.type === 'root' ? 0.8 : 1
  const ageDarkening = 0.98 - part.age * 0.09
  const value = (0.8 + variation * 0.2 + verticalGrain * 0.025) *
    rootDarkening * ageDarkening
  if (part.id.includes('fruit-stalk') && part.id.includes('-strand-')) {
    // Date bunches are swept with the woody topology so their individual
    // fruits retain a real silhouette. A warm vertex tint separates the ripe
    // tissue from the shared bark material without another draw call.
    return vec3(value * 1.16, value * 0.68, value * 0.24)
  }
  return vec3(
    value * (1 - moss * 0.2),
    value * (0.94 + moss * 0.05),
    value * (0.86 - moss * 0.16),
  )
}

/**
 * Which members are worth sweeping at a given LOD.
 *
 * Radius is the rule, with one exception: the members that stake out the crown's
 * extremes are kept even when they are thin, because culling them purely on
 * radius pulls the distant silhouette in from the extent the hero LOD sets, and
 * silhouette is the only thing a distant tree has.
 */
function retainedParts(
  parts: readonly SemanticTreePart[],
  settings: MeshSettings,
  bounds: TreeBounds,
): SemanticTreePart[] {
  if (settings.level === 0) return [...parts]
  const error = settings.geometricError
  return parts.filter((part) => {
    if (part.type === 'trunk' || part.junctionType === 'continuation') return true
    const maximumRadius = part.spine.reduce(
      (maximum, sample) => Math.max(maximum, sample.radius),
      0,
    )
    const threshold = settings.level === 1
      ? error * (part.type === 'twig' ? 0.5 : 0.22)
      : error * (part.type === 'root' ? 0.6 : 0.55)
    if (maximumRadius > threshold) return true
    return part.branchOrder <= (settings.level === 1 ? 3 : 2) &&
      part.type !== 'root' &&
      definesCrownEnvelope(part, bounds)
  })
}

function definesCrownEnvelope(part: SemanticTreePart, bounds: TreeBounds): boolean {
  const spanX = Math.max(1, bounds.max.x - bounds.min.x)
  const spanY = Math.max(1, bounds.max.y - bounds.min.y)
  const spanZ = Math.max(1, bounds.max.z - bounds.min.z)
  for (const sample of part.spine) {
    if (sample.position.y >= bounds.max.y - spanY * 0.115) return true
    if (sample.position.x <= bounds.min.x + spanX * 0.11) return true
    if (sample.position.x >= bounds.max.x - spanX * 0.11) return true
    if (sample.position.z <= bounds.min.z + spanZ * 0.11) return true
    if (sample.position.z >= bounds.max.z - spanZ * 0.11) return true
  }
  return false
}

function settingsFor(
  graph: SemanticTreeGraph,
  level: TreeLodLevel,
  qualityScale: number,
): MeshSettings {
  const height = Math.max(1, graph.bounds.max.y - graph.bounds.min.y)
  const baseError = level === 0
    ? clamp(height / 180, 0.1, 0.22)
    : level === 1
      ? clamp(height / 86, 0.24, 0.48)
      : clamp(height / 40, 0.5, 0.95)
  const geometricError = baseError * qualityScale
  return {
    geometricError,
    radialRelief: 1 / Math.max(1, qualityScale),
    targetStep: geometricError * (level === 0 ? 4.8 : level === 1 ? 4.35 : 3.75),
    maximumTurn: (level === 0 ? 13 : level === 1 ? 23 : 36) * (Math.PI / 180) * qualityScale,
    // 24 sides is a 40cm facet across a three-metre buttress, and a buttress is
    // routinely a metre from the camera. The cap only binds on the widest few
    // members of the near LOD, so the extra triangles land exactly where they
    // are looked at.
    maximumRadial: level === 0 ? 34 : level === 1 ? 14 : 8,
    minimumRadial: level === 0 ? 10 : level === 1 ? 6 : 5,
    level,
  }
}

function computeSmoothNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]! * 3
    const b = indices[offset + 1]! * 3
    const c = indices[offset + 2]! * 3
    const ab = vec3(
      positions[b]! - positions[a]!,
      positions[b + 1]! - positions[a + 1]!,
      positions[b + 2]! - positions[a + 2]!,
    )
    const ac = vec3(
      positions[c]! - positions[a]!,
      positions[c + 1]! - positions[a + 1]!,
      positions[c + 2]! - positions[a + 2]!,
    )
    const normal = cross(ab, ac)
    for (const vertexOffset of [a, b, c]) {
      normals[vertexOffset] += normal.x
      normals[vertexOffset + 1] += normal.y
      normals[vertexOffset + 2] += normal.z
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const normal = normalize(
      vec3(normals[offset], normals[offset + 1], normals[offset + 2]),
      vec3(0, 1, 0),
    )
    normals[offset] = normal.x
    normals[offset + 1] = normal.y
    normals[offset + 2] = normal.z
  }
  return normals
}

function boundsOf(positions: Float32Array): TreeBounds {
  const bounds = emptyBounds()
  for (let offset = 0; offset < positions.length; offset += 3) {
    includeInBounds(
      bounds,
      vec3(positions[offset], positions[offset + 1], positions[offset + 2]),
    )
  }
  return bounds
}
