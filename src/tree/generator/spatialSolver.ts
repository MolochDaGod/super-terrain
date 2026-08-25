import {
  add,
  clamp,
  groundHeightAt,
  length,
  multiply,
  normalize,
  subtract,
  vec3,
} from './math'
import type {
  SemanticTreeGraph,
  SemanticTreePart,
  TreeContact,
  TreeEnvironment,
  TreeParameters,
  TreeSpineSample,
  TreeVec3,
} from './types'
import { SpatialIndex } from './spatialIndex'

/**
 * A few cheap relaxation passes are enough for silhouette-level growth. This
 * is intentionally not a decades-long biological simulation: authored spines
 * stay legible and every correction remains deterministic.
 */
export function resolveTreeSpace(
  graph: SemanticTreeGraph,
  environment: TreeEnvironment,
  parameters: TreeParameters,
): void {
  const byId = new Map(graph.parts.map((part) => [part.id, part]))
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const field = buildSampleField(graph.parts)
    for (const part of graph.parts) {
      // A phyllotactic apical crown is already packed by botanical rank. Treating
      // its neighbouring petioles as accidental branch collisions makes the
      // solver kick their tips almost vertically and destroys the authored
      // crown bowl. The same exclusion keeps pendant fruit strings coherent.
      if (
        part.type === 'trunk' ||
        part.id === 'leader' ||
        part.id.startsWith('regime-apical-')
      ) continue
      for (let index = 1; index < part.spine.length; index += 1) {
        if (index === part.spine.length - 1 && part.type === 'root') continue
        const sample = part.spine[index]!
        const correction = collisionCorrection(
          part,
          sample,
          field,
          byId,
          parameters,
        )
        const obstacleCorrection = obstacleAvoidance(sample, environment)
        const stiffness = part.type === 'twig' ? 0.62 : part.type === 'root' ? 0.3 : 0.42
        sample.position = add(
          sample.position,
          multiply(add(correction, obstacleCorrection), stiffness / (iteration + 1)),
        )
        // An aerial root's whole point is that it is above the ground for most
        // of its run; only soil-bound roots follow the surface.
        if (part.type === 'root' && !part.aerial) {
          sample.position.y = groundHeightAt(
            sample.position.x,
            sample.position.z,
            environment.groundHeight,
            environment.slopeX,
            environment.slopeZ,
          ) - sample.burialDepth
        }
      }
    }
  }
  graph.contacts = buildContactGraph(graph.parts, byId)
}

interface FieldSample {
  part: SemanticTreePart
  sample: TreeSpineSample
  position: TreeVec3
  radius: number
}

function buildSampleField(parts: readonly SemanticTreePart[]): SpatialIndex<FieldSample> {
  const result: FieldSample[] = []
  for (const part of parts) {
    for (const sample of part.spine) {
      result.push({ part, sample, position: sample.position, radius: sample.radius })
    }
  }
  return new SpatialIndex(result)
}

function collisionCorrection(
  part: SemanticTreePart,
  sample: TreeSpineSample,
  field: SpatialIndex<FieldSample>,
  byId: ReadonlyMap<string, SemanticTreePart>,
  parameters: TreeParameters,
): TreeVec3 {
  let correction = vec3()
  const clearanceFactor = part.type === 'twig' ? 1.7 : 1.28
  for (const candidate of field.queryContacts(
    sample.position,
    sample.radius,
    clearanceFactor,
  )) {
    if (candidate.part.id === part.id) continue
    if (structurallyAdjacent(part, candidate.part, byId)) continue
    const delta = subtract(sample.position, candidate.sample.position)
    const distance = length(delta)
    const combinedRadius = sample.radius + candidate.sample.radius
    const clearance = combinedRadius * (part.type === 'twig' ? 1.7 : 1.28)
    if (distance >= clearance || distance < 1e-5) continue

    const oldWoodContact =
      part.age > 0.58 &&
      candidate.part.age > 0.58 &&
      part.type !== 'twig' &&
      candidate.part.type !== 'twig'
    if (oldWoodContact && distance > combinedRadius * 0.76) continue

    const strength = (1 - distance / clearance) *
      (0.16 + parameters.gnarl * 0.08)
    let direction = normalize(delta, vec3(1, 0, 0))
    if (part.type === 'root') {
      direction = normalize(vec3(direction.x, 0, direction.z), vec3(1, 0, 0))
    }
    correction = add(correction, multiply(direction, strength * clearance))
  }
  return correction
}

function obstacleAvoidance(
  sample: TreeSpineSample,
  environment: TreeEnvironment,
): TreeVec3 {
  let correction = vec3()
  for (const obstacle of environment.obstacles) {
    const delta = subtract(sample.position, obstacle.center)
    const distance = length(delta)
    const clearance = obstacle.radius + sample.radius * 1.4
    if (distance >= clearance || distance < 1e-5) continue
    const pressure = 1 - distance / clearance
    correction = add(
      correction,
      multiply(normalize(delta, vec3(1, 0, 0)), pressure * clearance * 0.55),
    )
  }
  return correction
}

/**
 * Records where two structurally unrelated members actually touch.
 *
 * Every pair against every pair is a fine description of the problem and a
 * terrible way to compute it: a crown of several hundred shoots turns that into
 * hundreds of thousands of spine-against-spine comparisons and dominates the
 * cost of generating the tree. The contact set is sparse — it is the pairs that
 * are within a radius or so of each other — so it is found by querying the same
 * sample field the collision pass uses, and only the pairs the field proposes
 * are measured properly.
 */
function buildContactGraph(
  parts: readonly SemanticTreePart[],
  byId: ReadonlyMap<string, SemanticTreePart>,
): TreeContact[] {
  const contacts: TreeContact[] = []
  const recorded = new Set<string>()
  const field = buildSampleField(parts)
  const candidates = new Map<string, { left: SemanticTreePart; right: SemanticTreePart }>()
  for (const left of parts) {
    for (const sample of left.spine) {
      for (const candidate of field.queryContacts(
        sample.position,
        sample.radius,
        1.18,
      )) {
        const right = candidate.part
        if (right.id === left.id) continue
        if (structurallyAdjacent(left, right, byId)) continue
        const key = left.id < right.id
          ? `${left.id}|${right.id}`
          : `${right.id}|${left.id}`
        if (candidates.has(key)) continue
        candidates.set(
          key,
          left.id < right.id ? { left, right } : { left: right, right: left },
        )
      }
    }
  }
  for (const [key, pair] of candidates) {
    const { left, right } = pair
    {
      let closest:
        | { distance: number; a: TreeSpineSample; b: TreeSpineSample }
        | undefined
      for (const a of left.spine) {
        for (const b of right.spine) {
          const distance = length(subtract(a.position, b.position))
          if (!closest || distance < closest.distance) closest = { distance, a, b }
        }
      }
      if (!closest) continue
      const combinedRadius = closest.a.radius + closest.b.radius
      if (closest.distance > combinedRadius * 1.18) continue
      if (recorded.has(key)) continue
      recorded.add(key)
      const pressure = clamp(1 - closest.distance / Math.max(1e-5, combinedRadius), 0, 1)
      const bothRoots = left.type === 'root' && right.type === 'root'
      const mature = Math.min(left.age, right.age)
      contacts.push({
        partA: left.id,
        partB: right.id,
        locationA: { ...closest.a.position },
        locationB: { ...closest.b.position },
        type: bothRoots ? 'resting' : pressure > 0.65 ? 'crossing' : 'touching',
        age: mature,
        pressure,
        fusion: pressure > 0.72 && mature > 0.7 ? pressure * mature * 0.42 : 0,
      })
    }
  }
  return contacts
}

function structurallyAdjacent(
  a: SemanticTreePart,
  b: SemanticTreePart,
  byId: ReadonlyMap<string, SemanticTreePart>,
): boolean {
  if (a.parentId === b.id || b.parentId === a.id) return true
  const aParent = a.parentId ? byId.get(a.parentId) : undefined
  const bParent = b.parentId ? byId.get(b.parentId) : undefined
  return Boolean(aParent && bParent && aParent.id === bParent.id)
}
