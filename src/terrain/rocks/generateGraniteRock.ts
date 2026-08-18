import type { AABB } from '../core/types'
import { extractGraniteSurface, type GraniteSurface } from './dualContourGranite'
import { createGlacialGraniteField } from './glacialGraniteField'
import { fbm, ridged, worleyBorder } from './glacialGraniteNoise'
import { repairGraniteSurface } from './repairGraniteSurface'
import {
  graniteRockTopologyKey,
  graniteSourceSeed,
  normalizeGraniteRockParameters,
  normalizeGraniteRockTransform,
  type GraniteRockMesh,
  type GraniteRockParameters,
  type GraniteRockTransform,
  type GraniteSourceSeed,
  type GraniteTopologyDetail,
} from './types'

const topologyCache = new Map<string, GraniteSurface>()
const rockCache = new Map<string, GraniteRockMesh>()
const MAX_CACHED_TOPOLOGIES = 24
const MAX_CACHED_ROCKS = 32
const SOURCE_WORLD_SCALE = [1.82, 1.62, 1.7] as const

/**
 * Materializes scifi-kit's glacial-granite analytic field through its QEF
 * dual-contour pipeline. The extracted surface is repaired into one closed,
 * consistently wound two-manifold so it remains valid input for exact CSG.
 */
export function generateGraniteRock(
  input: GraniteRockParameters,
): GraniteRockMesh {
  const parameters = normalizeGraniteRockParameters(input)
  const key = graniteRockTopologyKey(parameters)
  const cached = rockCache.get(key)
  if (cached) return cached

  const source = sourceTopology(parameters)
  const positions = new Float32Array(source.positions.length)
  let minimumY = Infinity
  for (let offset = 0; offset < positions.length; offset += 3) {
    positions[offset] = source.positions[offset]! *
      SOURCE_WORLD_SCALE[0] * parameters.placementScale
    positions[offset + 1] = source.positions[offset + 1]! *
      SOURCE_WORLD_SCALE[1] * parameters.placementScale
    positions[offset + 2] = source.positions[offset + 2]! *
      SOURCE_WORLD_SCALE[2] * parameters.placementScale
    minimumY = Math.min(minimumY, positions[offset + 1]!)
  }
  // scifi-kit materializes every compiled rock on a zero-height planting plane.
  // Keep the editable/CSG mesh in that identical local coordinate system.
  for (let offset = 1; offset < positions.length; offset += 3) {
    positions[offset] -= minimumY
  }
  const normals = computeNormals(positions, source.indices)
  const colors = graniteVertexColors(positions, normals, parameters)
  const mesh: GraniteRockMesh = {
    positions,
    normals,
    colors,
    indices: source.indices,
    bounds: boundsOf(positions),
  }
  rockCache.set(key, mesh)
  trimOldest(rockCache, MAX_CACHED_ROCKS)
  return mesh
}

function sourceTopology(parameters: GraniteRockParameters): GraniteSurface {
  const sourceSeed = graniteSourceSeed(parameters.seed)
  const cells = parameters.topologyDetail
  const cached = topologyCache.get(topologyCacheKey(sourceSeed, cells))
  if (cached) return cached
  return primeGraniteTopology(
    sourceSeed,
    cells,
    extractGraniteTopology(sourceSeed, cells),
  )
}

function topologyCacheKey(
  sourceSeed: GraniteSourceSeed,
  cells: GraniteTopologyDetail,
): string {
  return `${sourceSeed}:${cells}`
}

/**
 * Dual-contours and repairs one source archetype at one grid resolution. Pure
 * and free of DOM access, so a worker can run the heavy tiers off the main
 * thread and hand the result back through `primeGraniteTopology`.
 */
export function extractGraniteTopology(
  sourceSeed: GraniteSourceSeed,
  cells: GraniteTopologyDetail,
): GraniteSurface {
  const extracted = extractGraniteSurface({
    field: createGlacialGraniteField(sourceSeed),
    seed: sourceSeed,
    cells,
  })
  const repaired = repairGraniteSurface(extracted)
  assertCsgTopology(repaired.positions, repaired.indices)
  return repaired
}

/** Inserts an already-extracted surface so the next generate call is a hit. */
export function primeGraniteTopology(
  sourceSeed: GraniteSourceSeed,
  cells: GraniteTopologyDetail,
  surface: GraniteSurface,
): GraniteSurface {
  topologyCache.set(topologyCacheKey(sourceSeed, cells), surface)
  trimOldest(topologyCache, MAX_CACHED_TOPOLOGIES)
  return surface
}

export function hasGraniteTopology(
  sourceSeed: GraniteSourceSeed,
  cells: GraniteTopologyDetail,
): boolean {
  return topologyCache.has(topologyCacheKey(sourceSeed, cells))
}

export function transformGraniteRockPositions(
  positions: ArrayLike<number>,
  input: GraniteRockTransform,
): number[] {
  const transform = normalizeGraniteRockTransform(input)
  const result = new Array<number>(positions.length)
  const sx = Math.sin(transform.rotation.x)
  const cx = Math.cos(transform.rotation.x)
  const sy = Math.sin(transform.rotation.y)
  const cy = Math.cos(transform.rotation.y)
  const sz = Math.sin(transform.rotation.z)
  const cz = Math.cos(transform.rotation.z)
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = Number(positions[offset]) * transform.scale.x
    const y = Number(positions[offset + 1]) * transform.scale.y
    const z = Number(positions[offset + 2]) * transform.scale.z
    const x1 = x
    const y1 = y * cx - z * sx
    const z1 = y * sx + z * cx
    const x2 = x1 * cy + z1 * sy
    const y2 = y1
    const z2 = -x1 * sy + z1 * cy
    result[offset] = x2 * cz - y2 * sz + transform.position.x
    result[offset + 1] = x2 * sz + y2 * cz + transform.position.y
    result[offset + 2] = z2 + transform.position.z
  }
  return result
}

function graniteVertexColors(
  positions: Float32Array,
  normals: Float32Array,
  parameters: GraniteRockParameters,
): Float32Array {
  const colors = new Float32Array(positions.length)
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = positions[offset]! / (SOURCE_WORLD_SCALE[0] * parameters.placementScale)
    const y = positions[offset + 1]! / (SOURCE_WORLD_SCALE[1] * parameters.placementScale)
    const z = positions[offset + 2]! / (SOURCE_WORLD_SCALE[2] * parameters.placementScale)
    const macro = fbm(
      x * 4.2 + 3.1,
      y * 3.8 - 5.7,
      z * 4.2 + 8.4,
      parameters.seed + 811,
      3,
    )
    const mineral = ridged(
      x * 17,
      y * 17,
      z * 17,
      parameters.seed + 857,
      3,
    )
    const crystal = fbm(
      x * 42,
      y * 42,
      z * 42,
      parameters.seed + 907,
      2,
    )
    const border = worleyBorder(
      x * 20,
      y * 20,
      z * 20,
      parameters.seed + 953,
    )
    const cavity = 1 - Math.min(1, border / 0.24)
    const upward = Math.max(0, normals[offset + 1]!)
    let red = 0.35 + macro * 0.15
    let green = 0.34 + macro * 0.14
    let blue = 0.31 + macro * 0.13
    const feldspar = smoothstep(0.58, 0.92, mineral)
    const biotite = smoothstep(0.42, 0.74, -crystal)
    red += feldspar * 0.25 - biotite * 0.18 - cavity * cavity * 0.12
    green += feldspar * 0.2 - biotite * 0.17 - cavity * cavity * 0.11
    blue += feldspar * 0.17 - biotite * 0.15 - cavity * cavity * 0.1
    const bleaching = upward * smoothstep(0.15, 0.65, macro + 0.4) * 0.08
    colors[offset] = clamp01(red + bleaching)
    colors[offset + 1] = clamp01(green + bleaching)
    colors[offset + 2] = clamp01(blue + bleaching)
  }
  return colors
}

function computeNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let offset = 0; offset < indices.length; offset += 3) {
    const ia = indices[offset]! * 3
    const ib = indices[offset + 1]! * 3
    const ic = indices[offset + 2]! * 3
    const abx = positions[ib]! - positions[ia]!
    const aby = positions[ib + 1]! - positions[ia + 1]!
    const abz = positions[ib + 2]! - positions[ia + 2]!
    const acx = positions[ic]! - positions[ia]!
    const acy = positions[ic + 1]! - positions[ia + 1]!
    const acz = positions[ic + 2]! - positions[ia + 2]!
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    normals[ia] += nx
    normals[ia + 1] += ny
    normals[ia + 2] += nz
    normals[ib] += nx
    normals[ib + 1] += ny
    normals[ib + 2] += nz
    normals[ic] += nx
    normals[ic + 1] += ny
    normals[ic + 2] += nz
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(
      normals[offset]!,
      normals[offset + 1]!,
      normals[offset + 2]!,
    ) || 1
    normals[offset] /= length
    normals[offset + 1] /= length
    normals[offset + 2] /= length
  }
  return normals
}

function boundsOf(positions: ArrayLike<number>): AABB {
  const bounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  }
  for (let offset = 0; offset < positions.length; offset += 3) {
    bounds.min.x = Math.min(bounds.min.x, Number(positions[offset]))
    bounds.min.y = Math.min(bounds.min.y, Number(positions[offset + 1]))
    bounds.min.z = Math.min(bounds.min.z, Number(positions[offset + 2]))
    bounds.max.x = Math.max(bounds.max.x, Number(positions[offset]))
    bounds.max.y = Math.max(bounds.max.y, Number(positions[offset + 1]))
    bounds.max.z = Math.max(bounds.max.z, Number(positions[offset + 2]))
  }
  return bounds
}

function assertCsgTopology(
  positions: Float64Array,
  indices: Uint32Array,
): void {
  const edgeUse = new Map<number, { count: number; balance: number }>()
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]!
    const b = indices[offset + 1]!
    const c = indices[offset + 2]!
    for (const [left, right] of [[a, b], [b, c], [c, a]]) {
      const key = left < right
        ? left * 4294967 + right
        : right * 4294967 + left
      const edge = edgeUse.get(key) ?? { count: 0, balance: 0 }
      edge.count += 1
      edge.balance += left < right ? 1 : -1
      edgeUse.set(key, edge)
    }
  }
  const invalidEdge = [...edgeUse.values()].find(
    (edge) => edge.count !== 2 || edge.balance !== 0,
  )
  if (invalidEdge !== undefined || signedVolume(positions, indices) <= 0) {
    throw new Error('Glacial granite extraction did not produce closed CSG topology')
  }
}

function signedVolume(
  positions: Float64Array,
  indices: Uint32Array,
): number {
  let volume = 0
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]! * 3
    const b = indices[offset + 1]! * 3
    const c = indices[offset + 2]! * 3
    volume += positions[a]! *
      (positions[b + 1]! * positions[c + 2]! -
        positions[b + 2]! * positions[c + 1]!) +
      positions[a + 1]! *
      (positions[b + 2]! * positions[c]! -
        positions[b]! * positions[c + 2]!) +
      positions[a + 2]! *
      (positions[b]! * positions[c + 1]! -
        positions[b + 1]! * positions[c]!)
  }
  return volume / 6
}

function trimOldest<Key, Value>(
  cache: Map<Key, Value>,
  maximum: number,
): void {
  if (cache.size <= maximum) return
  const oldest = cache.keys().next().value as Key | undefined
  if (oldest !== undefined) cache.delete(oldest)
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0))
  return amount * amount * (3 - 2 * amount)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
