import { clamp, worldToSection } from '../core/bounds'
import type { TerrainLodDetailFocus } from '../config'
import type {
  CompiledLOD,
  SectionId,
  SectionKey,
  Vec3Like,
} from '../core/types'

export interface LodSelectionInput {
  lods: readonly Pick<CompiledLOD, 'level' | 'geometricError'>[]
  distance: number
  viewportHeight: number
  verticalFovRadians: number
  errorTolerancePixels: number
  currentLod: number
  /** Section-grid distance from the camera's terrain section. */
  focusDistanceSections?: number
  /** Sections inside this radius retain the finest available topology. */
  lod0FocusRadiusSections?: number
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
  const focusCeiling =
    input.focusDistanceSections !== undefined &&
    input.lod0FocusRadiusSections !== undefined
      ? focusedLodCeiling(
        input.focusDistanceSections,
        input.lod0FocusRadiusSections,
        input.lods[input.lods.length - 1].level,
      )
      : Infinity
  const applyFocusCeiling = (lod: number) => Math.min(lod, focusCeiling)
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
  if (candidate.level === current.level) return applyFocusCeiling(current.level)
  if (candidate.level < current.level) {
    const currentError = projectedGeometricError(
      current.geometricError,
      input.distance,
      input.viewportHeight,
      input.verticalFovRadians,
    )
    return applyFocusCeiling(currentError > input.errorTolerancePixels * 1.16
      ? candidate.level
      : current.level)
  }

  const candidateError = projectedGeometricError(
    candidate.geometricError,
    input.distance,
    input.viewportHeight,
    input.verticalFovRadians,
  )
  return applyFocusCeiling(candidateError < input.errorTolerancePixels * 0.72
    ? candidate.level
    : current.level)
}

/** Finest LOD ring required by distance from the camera's terrain section. */
export function focusedLodCeiling(
  distanceInSections: number,
  lod0RadiusSections: number,
  maximumLevel: number,
): number {
  return clamp(
    Math.ceil(Math.max(0, distanceInSections - lod0RadiusSections)),
    0,
    maximumLevel,
  )
}

/** Section-grid distance from a terrain cell to the cell below the camera. */
export function cameraSectionDistance(
  section: SectionKey,
  camera: Pick<Vec3Like, 'x' | 'z'>,
  sectionSize: number,
): number {
  const cameraSection = worldToSection(camera.x, camera.z, sectionSize)
  return Math.hypot(
    section.x - cameraSection.x,
    section.z - cameraSection.z,
  )
}

/**
 * Finest LOD allowed by a fixed world-space presentation focus.
 *
 * Unlike the camera editing ring, this follows the subject of a composed view:
 * a distant landmark can occupy hundreds of pixels while being several section
 * radii from the camera. The ceiling relaxes by one level per outer ring so it
 * remains compatible with the ordinary neighbour constraint.
 */
export function detailFocusLodCeiling(
  section: SectionKey,
  focus: TerrainLodDetailFocus,
  sectionSize: number,
  maximumLevel: number,
): number {
  const ring = focusedLodCeiling(
    cameraSectionDistance(section, focus, sectionSize),
    focus.radiusSections,
    maximumLevel,
  )
  return clamp(focus.finestLod + ring, 0, maximumLevel)
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
  if (nodes.length === 0) return result
  const rows = new Map<number, Map<number, LodNeighborNode>>()
  let maximumLevel = 0
  for (const node of nodes) {
    let row = rows.get(node.z)
    if (!row) {
      row = new Map()
      rows.set(node.z, row)
    }
    row.set(node.x, node)
    maximumLevel = Math.max(maximumLevel, node.lod)
  }

  // The fixed point is min(source LOD + Manhattan distance). Unit edges and
  // the tiny integer LOD range make Dial buckets a linear solve: every useful
  // relaxation moves a section to a strictly finer bucket.
  const buckets = Array.from(
    { length: maximumLevel + 1 },
    () => [] as LodNeighborNode[],
  )
  for (const node of nodes) buckets[node.lod].push(node)
  for (let level = 0; level <= maximumLevel; level += 1) {
    const bucket = buckets[level]
    while (bucket.length > 0) {
      const node = bucket.pop()!
      if (result.get(node.id) !== level) continue
      relaxNeighbor(rows.get(node.z)?.get(node.x + 1), level, result, buckets)
      relaxNeighbor(rows.get(node.z)?.get(node.x - 1), level, result, buckets)
      relaxNeighbor(rows.get(node.z + 1)?.get(node.x), level, result, buckets)
      relaxNeighbor(rows.get(node.z - 1)?.get(node.x), level, result, buckets)
    }
  }
  return result
}

function relaxNeighbor(
  neighbor: LodNeighborNode | undefined,
  sourceLevel: number,
  result: Map<SectionId, number>,
  buckets: LodNeighborNode[][],
): void {
  if (!neighbor) return
  const candidate = sourceLevel + 1
  const current = result.get(neighbor.id) ?? neighbor.lod
  if (candidate >= current) return
  result.set(neighbor.id, candidate)
  buckets[candidate].push(neighbor)
}
