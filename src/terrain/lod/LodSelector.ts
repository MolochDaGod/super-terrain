import { clamp } from '../core/bounds'
import type { CompiledLOD, SectionId } from '../core/types'

export interface LodSelectionInput {
  lods: readonly Pick<CompiledLOD, 'level' | 'geometricError'>[]
  distance: number
  viewportHeight: number
  verticalFovRadians: number
  errorTolerancePixels: number
  currentLod: number
}

export function projectedGeometricError(
  geometricError: number,
  distance: number,
  viewportHeight: number,
  verticalFovRadians: number,
): number {
  const projectionScale = viewportHeight / (2 * Math.tan(verticalFovRadians * 0.5))
  return (geometricError * projectionScale) / Math.max(distance, 0.001)
}

export function selectLod(input: LodSelectionInput): number {
  if (input.lods.length === 0) return 0
  let candidateIndex = 0
  for (let index = input.lods.length - 1; index >= 0; index -= 1) {
    const error = projectedGeometricError(
      input.lods[index].geometricError,
      input.distance,
      input.viewportHeight,
      input.verticalFovRadians,
    )
    if (error <= input.errorTolerancePixels) {
      candidateIndex = index
      break
    }
  }

  const currentIndex = closestLodIndex(input.lods, input.currentLod)
  const candidate = input.lods[candidateIndex]
  const current = input.lods[currentIndex]
  if (candidate.level === current.level) return current.level
  if (candidate.level < current.level) {
    const currentError = projectedGeometricError(
      current.geometricError,
      input.distance,
      input.viewportHeight,
      input.verticalFovRadians,
    )
    return currentError > input.errorTolerancePixels * 1.16
      ? candidate.level
      : current.level
  }

  const candidateError = projectedGeometricError(
    candidate.geometricError,
    input.distance,
    input.viewportHeight,
    input.verticalFovRadians,
  )
  return candidateError < input.errorTolerancePixels * 0.72
    ? candidate.level
    : current.level
}

export interface SourceLodSelectionInput {
  lodResolutions: readonly number[]
  sectionSize: number
  distance: number
  viewportHeight: number
  verticalFovRadians: number
  errorTolerancePixels: number
}

/**
 * Coarsest source grid that is already below the current screen-space error.
 * This lets streaming build what can be displayed now instead of eagerly
 * generating hidden LOD0 topology for every section in the working set.
 */
export function selectSourceLod(input: SourceLodSelectionInput): number {
  const lastLevel = input.lodResolutions.length - 1
  for (let level = lastLevel; level > 0; level -= 1) {
    const resolution = input.lodResolutions[level]
    const geometricError =
      (input.sectionSize / Math.max(1, resolution)) * 0.075
    if (
      projectedGeometricError(
        geometricError,
        input.distance,
        input.viewportHeight,
        input.verticalFovRadians,
      ) <= input.errorTolerancePixels
    ) {
      return level
    }
  }
  return 0
}

function closestLodIndex(
  lods: readonly Pick<CompiledLOD, 'level'>[],
  requested: number,
): number {
  let closest = 0
  let closestDistance = Infinity
  for (let index = 0; index < lods.length; index += 1) {
    const distance = Math.abs(lods[index].level - requested)
    if (distance < closestDistance) {
      closest = index
      closestDistance = distance
    }
  }
  return clamp(closest, 0, lods.length - 1)
}

export interface LodNeighborNode {
  id: SectionId
  x: number
  z: number
  lod: number
}

export function constrainNeighborLods(nodes: LodNeighborNode[]): Map<SectionId, number> {
  const result = new Map<SectionId, number>(nodes.map((node) => [node.id, node.lod]))
  const coordinates = new Map(nodes.map((node) => [`${node.x}:${node.z}`, node]))
  let changed = true
  let pass = 0
  while (changed && pass < 8) {
    changed = false
    pass += 1
    for (const node of nodes) {
      const current = result.get(node.id) ?? node.lod
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const neighbor = coordinates.get(`${node.x + dx}:${node.z + dz}`)
        if (!neighbor) continue
        const neighborLod = result.get(neighbor.id) ?? neighbor.lod
        if (current > neighborLod + 1) {
          result.set(node.id, neighborLod + 1)
          changed = true
        }
      }
    }
  }
  return result
}
