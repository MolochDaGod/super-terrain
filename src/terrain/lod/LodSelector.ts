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
  let candidate = 0
  for (let index = input.lods.length - 1; index >= 0; index -= 1) {
    const error = projectedGeometricError(
      input.lods[index].geometricError,
      input.distance,
      input.viewportHeight,
      input.verticalFovRadians,
    )
    if (error <= input.errorTolerancePixels) {
      candidate = index
      break
    }
  }

  const current = clamp(input.currentLod, 0, input.lods.length - 1)
  if (candidate === current) return current
  if (candidate < current) {
    const currentError = projectedGeometricError(
      input.lods[current].geometricError,
      input.distance,
      input.viewportHeight,
      input.verticalFovRadians,
    )
    return currentError > input.errorTolerancePixels * 1.16 ? candidate : current
  }

  const candidateError = projectedGeometricError(
    input.lods[candidate].geometricError,
    input.distance,
    input.viewportHeight,
    input.verticalFovRadians,
  )
  return candidateError < input.errorTolerancePixels * 0.72 ? candidate : current
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
