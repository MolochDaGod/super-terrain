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
      if (part.type === 'trunk' || part.id === 'leader') continue
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
        if (part.type === 'root') {
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
}

function buildSampleField(parts: readonly SemanticTreePart[]): FieldSample[] {
  const result: FieldSample[] = []
  for (const part of parts) {
    for (const sample of part.spine) result.push({ part, sample })
  }
  return result
}

function collisionCorrection(
  part: SemanticTreePart,
  sample: TreeSpineSample,
  field: readonly FieldSample[],
  byId: ReadonlyMap<string, SemanticTreePart>,
  parameters: TreeParameters,
): TreeVec3 {
  let correction = vec3()
  for (const candidate of field) {
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

function buildContactGraph(
  parts: readonly SemanticTreePart[],
  byId: ReadonlyMap<string, SemanticTreePart>,
): TreeContact[] {
  const contacts: TreeContact[] = []
  const recorded = new Set<string>()
  for (let leftIndex = 0; leftIndex < parts.length; leftIndex += 1) {
    const left = parts[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < parts.length; rightIndex += 1) {
      const right = parts[rightIndex]!
      if (structurallyAdjacent(left, right, byId)) continue
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
      const key = `${left.id}|${right.id}`
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
