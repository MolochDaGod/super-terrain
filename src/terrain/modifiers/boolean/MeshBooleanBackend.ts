import {
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  MeshBasicMaterial,
} from 'three'
import { ADDITION, Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg'
import type { BooleanSubtractModifier, CsgOperation } from '../types'
import { transformedTunnel } from '../transform'
import { tunnelPathPoints } from '../tunnel'
import {
  cutterBounds,
  cutterGeometry,
  type SweepRing,
  type CutterVolume,
} from './CutterVolume'

export interface BooleanMeshBuffers {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  interiorVertices: Uint8Array
  /** One entry per triangle: 1 when the visible face came from an add operand. */
  triangleSurfaceKinds?: Uint8Array
}

export const TERRAIN_SURFACE_TRIANGLE = 0
export const PATCH_SURFACE_TRIANGLE = 1

export interface MeshBooleanBackend {
  readonly id: string
  evaluate(
    target: BooleanMeshBuffers,
    operations: readonly MeshBooleanOperation[],
    sectionOriginX: number,
    sectionOriginZ: number,
    sectionSize: number,
    detail: number,
    seed?: number,
  ): BooleanMeshBuffers
  subtract(
    target: BooleanMeshBuffers,
    cutters: CutterVolume[],
    sectionOriginX: number,
    sectionOriginZ: number,
    sectionSize: number,
    detail: number,
    seed?: number,
  ): BooleanMeshBuffers
}

export interface MeshBooleanOperation {
  operation: CsgOperation
  cutters: readonly CutterVolume[]
}

/**
 * The world-space volumes an authored tunnel removes.
 *
 * A tunnel is emitted as one continuous, closed sweep rather than as several
 * overlapping capsules. The whole passage therefore receives the same varying
 * cross-section and displacement before one exact Boolean subtraction.
 */
export function tunnelCutterVolumes(
  modifier: BooleanSubtractModifier,
): CutterVolume[] {
  const tunnel = transformedTunnel(modifier)
  return [
    {
      kind: 'sweep',
      rings: createTunnelSweep(
        tunnelPathPoints(tunnel),
        tunnel.radius,
        tunnel.noise,
        tunnel.noiseScale,
      ),
      surface: 'cave',
      noise: tunnel.noise,
      noiseScale: tunnel.noiseScale,
    },
    ...(tunnel.carves ?? []),
  ]
}

function createTunnelSweep(
  controls: ReturnType<typeof tunnelPathPoints>,
  radius: number,
  noise: number,
  noiseScale: number,
): SweepRing[] {
  const controlLength =
    distance(controls[0], controls[1]) +
    distance(controls[1], controls[2]) +
    distance(controls[2], controls[3])
  const segments = Math.max(24, Math.min(96, Math.ceil(controlLength / 3)))
  const rings: SweepRing[] = []
  for (let segment = 0; segment <= segments; segment += 1) {
    const t = segment / segments
    const point = cubicBezier(controls, t)
    const interior = Math.sin(Math.PI * t)
    const broadPhase =
      (t * controlLength * Math.PI * 2) / Math.max(1, noiseScale * 6.5)
    const broadSwell = Math.sin(broadPhase + 0.4) * interior
    const narrowSwell = Math.sin(broadPhase * 2.2 + 1.7) * interior
    const shapeNoise = Math.max(0, Math.min(2, noise))
    rings.push({
      ...point,
      horizontalRadius:
        radius * (0.94 + interior * 0.12 + broadSwell * 0.08 * shapeNoise),
      verticalRadius:
        radius * (0.78 + interior * 0.08 + narrowSwell * 0.055 * shapeNoise),
    })
  }
  return rings
}

function cubicBezier(
  points: ReturnType<typeof tunnelPathPoints>,
  t: number,
): { x: number; y: number; z: number } {
  const inverse = 1 - t
  const a = inverse * inverse * inverse
  const b = 3 * inverse * inverse * t
  const c = 3 * inverse * t * t
  const d = t * t * t
  return {
    x: points[0].x * a + points[1].x * b + points[2].x * c + points[3].x * d,
    y: points[0].y * a + points[1].y * b + points[2].y * c + points[3].y * d,
    z: points[0].z * a + points[1].z * b + points[2].z * c + points[3].z * d,
  }
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
}

/**
 * Worker-only volumetric CSG backend. The open authoring surface is temporarily
 * closed into a solid, tunnel volumes are subtracted with BVH-accelerated CSG,
 * then artificial section-side and bottom faces are stripped from the result.
 * The retained output contains the split portal surface and connected cave
 * walls/ceiling/floor produced by the boolean itself.
 */
export class BvhCsgTunnelBooleanBackend implements MeshBooleanBackend {
  readonly id = 'bvh-csg-nondestructive-v4'
  private readonly surfaceMaterial = new MeshBasicMaterial()
  private readonly patchMaterial = new MeshBasicMaterial()
  private readonly closureMaterial = new MeshBasicMaterial()
  private readonly interiorMaterial = new MeshBasicMaterial()
  private readonly emberInteriorMaterial = new MeshBasicMaterial()

  subtract(
    target: BooleanMeshBuffers,
    cutters: CutterVolume[],
    sectionOriginX: number,
    sectionOriginZ: number,
    sectionSize: number,
    detail: number,
    seed = 0,
  ): BooleanMeshBuffers {
    return this.evaluate(
      target,
      [{ operation: 'subtract', cutters }],
      sectionOriginX,
      sectionOriginZ,
      sectionSize,
      detail,
      seed,
    )
  }

  evaluate(
    target: BooleanMeshBuffers,
    operations: readonly MeshBooleanOperation[],
    sectionOriginX: number,
    sectionOriginZ: number,
    sectionSize: number,
    detail: number,
    seed = 0,
  ): BooleanMeshBuffers {
    if (operations.length === 0) return target

    const sectionMaximumX = sectionOriginX + sectionSize
    const sectionMaximumZ = sectionOriginZ + sectionSize
    const localOperations = operations
      .map((operation) => ({
        operation: operation.operation,
        cutters: operation.cutters.filter((cutter) => {
          const bounds = cutterBounds(cutter)
          return (
            bounds.min.x <= sectionMaximumX &&
            bounds.max.x >= sectionOriginX &&
            bounds.min.z <= sectionMaximumZ &&
            bounds.max.z >= sectionOriginZ
          )
        }),
      }))
      .filter((operation) => operation.cutters.length > 0)
    if (localOperations.length === 0) return target

    // Tunnel segments deliberately overlap at bends. Concatenating those shells
    // into one Brush creates a self-intersecting, non-manifold cutter; exact CSG
    // then classifies large parts of the section inconsistently and can erase a
    // whole tile. Apply each closed volume as its own Boolean instead. The result
    // is exactly target \ union(cutters), including where the volumes overlap.
    const steps = localOperations.flatMap((operation) =>
      operation.cutters.map((cutter) => ({
        operation: operation.operation,
        interior: cutter.interior,
        geometry: cutterGeometry(cutter, detail, seed),
      })),
    )
    const geometries = steps.map((step) => step.geometry)
    const translation = new Matrix4().makeTranslation(
      -sectionOriginX,
      0,
      -sectionOriginZ,
    )

    const evaluator = new Evaluator()
    evaluator.attributes = ['position', 'normal']
    evaluator.useGroups = true
    // GeometryBuilder in three-bvh-csg 0.0.18 sorts consolidated material
    // groups before clamping them to the groups that actually emitted
    // triangles. When a Boolean removes a group, that can put a sparse source
    // index inside the retained prefix and make buildGeometry read an
    // undefined group buffer. We need the groups for surface provenance, but
    // not this consolidation: extractVisibleGeometry compacts them immediately
    // after the operation and compares the material objects directly.
    // The package declaration still calls this older option
    // `consolidateMaterials`; 0.0.18's runtime property is consolidateGroups.
    const evaluatorWithRuntimeOptions = evaluator as Evaluator & {
      consolidateGroups: boolean
    }
    evaluatorWithRuntimeOptions.consolidateGroups = false

    let result = this.createTerrainSolid(target, sectionSize, geometries)
    for (const step of steps) {
      const { geometry, operation } = step
      geometry.applyMatrix4(translation)
      const cutterBrush = new Brush(
        geometry,
        operation === 'subtract'
          ? step.interior === 'ember'
            ? this.emberInteriorMaterial
            : this.interiorMaterial
          : this.patchMaterial,
      )
      cutterBrush.updateMatrixWorld(true)
      const previous = result
      result = evaluator.evaluate(
        previous,
        cutterBrush,
        operation === 'subtract' ? SUBTRACTION : ADDITION,
      )
      if (result !== previous) previous.geometry.dispose()
      cutterBrush.geometry.dispose()
    }

    const extracted = this.extractVisibleGeometry(result)
    snapSectionBoundaryVertices(extracted.positions, sectionSize)
    const cleaned = removeBooleanSliverTriangles(extracted)
    const continuous = smoothBooleanJunctionNormals(cleaned)
    const owned = retainOwnedSectionTriangles(
      continuous,
      sectionOriginX,
      sectionOriginZ,
      sectionSize,
    )
    result.geometry.dispose()
    return isUsableBooleanResult(owned) ? owned : target
  }

  private createTerrainSolid(
    target: BooleanMeshBuffers,
    sectionSize: number,
    cutters: readonly BufferGeometry[] = [],
  ): Brush {
    const boundaryEdges = findBoundaryEdges(target.indices)
    if (boundaryEdges.length === 0) {
      return this.createClosedTerrainSolid(target)
    }
    const vertexCount = target.positions.length / 3
    let minimumY = Infinity
    for (let offset = 1; offset < target.positions.length; offset += 3) {
      minimumY = Math.min(minimumY, target.positions[offset])
    }
    // The floor has to clear the deepest cutter as well as the terrain.
    //
    // A cutter that reaches past it punches through the artificial bottom cap,
    // and because that cap sits at a depth derived from each section's own
    // lowest vertex, two neighbouring sections cut it at different heights and
    // leave a crack along their shared edge — plus a skirt of stray interior
    // faces hanging in the void underneath. Keeping the cap strictly below
    // everything that will be subtracted means it is never cut at all.
    for (const cutter of cutters) {
      const positions = cutter.getAttribute('position')
      const array = positions.array as Float32Array
      for (let offset = 1; offset < array.length; offset += 3) {
        minimumY = Math.min(minimumY, array[offset])
      }
    }
    const bottomY = minimumY - Math.max(64, sectionSize * 0.75)
    const positions = new Float32Array(target.positions.length * 2)
    const normals = new Float32Array(target.normals.length * 2)
    positions.set(target.positions)
    normals.set(target.normals)
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const offset = vertex * 3
      const bottomOffset = target.positions.length + offset
      positions[bottomOffset] = target.positions[offset]
      positions[bottomOffset + 1] = bottomY
      positions[bottomOffset + 2] = target.positions[offset + 2]
      normals[target.normals.length + offset] = 0
      normals[target.normals.length + offset + 1] = -1
      normals[target.normals.length + offset + 2] = 0
    }

    const topIndices = Array.from(target.indices)
    const closureIndices: number[] = []
    for (let index = 0; index < target.indices.length; index += 3) {
      const a = target.indices[index] + vertexCount
      const b = target.indices[index + 1] + vertexCount
      const c = target.indices[index + 2] + vertexCount
      closureIndices.push(a, c, b)
    }
    for (const edge of boundaryEdges) {
      const bottomA = edge.a + vertexCount
      const bottomB = edge.b + vertexCount
      closureIndices.push(
        edge.a,
        bottomB,
        edge.b,
        edge.a,
        bottomA,
        bottomB,
      )
    }

    const indices = Uint32Array.from([...topIndices, ...closureIndices])
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new BufferAttribute(normals, 3))
    geometry.setIndex(new BufferAttribute(indices, 1))
    geometry.addGroup(0, topIndices.length, 0)
    geometry.addGroup(topIndices.length, closureIndices.length, 1)
    const brush = new Brush(geometry, [
      this.surfaceMaterial,
      this.closureMaterial,
    ])
    brush.updateMatrixWorld(true)
    return brush
  }

  private createClosedTerrainSolid(target: BooleanMeshBuffers): Brush {
    const geometry = new BufferGeometry()
    geometry.setAttribute(
      'position',
      new BufferAttribute(target.positions.slice(), 3),
    )
    geometry.setAttribute(
      'normal',
      new BufferAttribute(target.normals.slice(), 3),
    )
    geometry.setIndex(new BufferAttribute(target.indices.slice(), 1))
    geometry.addGroup(0, target.indices.length, 0)
    const brush = new Brush(geometry, [
      this.surfaceMaterial,
      this.closureMaterial,
    ])
    brush.updateMatrixWorld(true)
    return brush
  }

  private extractVisibleGeometry(result: Brush): BooleanMeshBuffers {
    const geometry = result.geometry
    const position = geometry.getAttribute('position') as BufferAttribute
    const normal = geometry.getAttribute('normal') as BufferAttribute
    const sourceIndices = geometry.getIndex()
    const materials = Array.isArray(result.material)
      ? result.material
      : [result.material]
    const positions: number[] = []
    const normals: number[] = []
    const indices: number[] = []
    const interior: number[] = []
    const triangleSurfaceKinds: number[] = []
    const vertexMap = new Map<string, number>()

    for (const group of geometry.groups) {
      const material = materials[group.materialIndex ?? 0]
      if (material === this.closureMaterial) continue
      const interiorKind = material === this.emberInteriorMaterial
        ? 2
        : material === this.interiorMaterial
          ? 1
          : 0
      const surfaceKind = material === this.patchMaterial
        ? PATCH_SURFACE_TRIANGLE
        : TERRAIN_SURFACE_TRIANGLE
      const end = Math.min(
        group.start + group.count,
        sourceIndices?.count ?? position.count,
      )
      for (let offset = group.start; offset + 2 < end; offset += 3) {
        const triangle = [0, 1, 2].map((corner) =>
          sourceIndices
            ? Number(sourceIndices.getX(offset + corner))
            : offset + corner,
        )
        if (isDegenerateTriangle(position, triangle)) continue
        triangleSurfaceKinds.push(surfaceKind)
        for (const sourceVertex of triangle) {
          const mapKey = `${sourceVertex}:${interiorKind}`
          let targetVertex = vertexMap.get(mapKey)
          if (targetVertex === undefined) {
            targetVertex = positions.length / 3
            vertexMap.set(mapKey, targetVertex)
            positions.push(
              position.getX(sourceVertex),
              position.getY(sourceVertex),
              position.getZ(sourceVertex),
            )
            normals.push(
              normal.getX(sourceVertex),
              normal.getY(sourceVertex),
              normal.getZ(sourceVertex),
            )
            interior.push(interiorKind)
          }
          indices.push(targetVertex)
        }
      }
    }

    return {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      indices: Uint32Array.from(indices),
      interiorVertices: Uint8Array.from(interior),
      triangleSurfaceKinds: Uint8Array.from(triangleSurfaceKinds),
    }
  }
}

/**
 * Makes the lighting normal continuous across the exact terrain/patch curve.
 *
 * three-bvh-csg correctly fuses the positions, but keeps each operand's source
 * normals. At their intersection that produces a dark outline which visually
 * re-separates the otherwise unified surface. Only vertices on a provenance
 * boundary are touched; fracture edges elsewhere retain their authored normal.
 */
export function smoothBooleanJunctionNormals(
  result: BooleanMeshBuffers,
): BooleanMeshBuffers {
  const kinds = result.triangleSurfaceKinds
  if (!kinds?.includes(PATCH_SURFACE_TRIANGLE)) return result

  const vertexCount = result.positions.length / 3
  const incidentKinds = new Uint8Array(vertexCount)
  const geometric = new Float32Array(result.normals.length)
  for (let offset = 0; offset < result.indices.length; offset += 3) {
    const triangle = offset / 3
    const a = result.indices[offset]!
    const b = result.indices[offset + 1]!
    const c = result.indices[offset + 2]!
    if (
      result.interiorVertices[a] !== 0 ||
      result.interiorVertices[b] !== 0 ||
      result.interiorVertices[c] !== 0
    ) {
      continue
    }
    const kindMask = kinds[triangle] === PATCH_SURFACE_TRIANGLE ? 2 : 1
    incidentKinds[a] |= kindMask
    incidentKinds[b] |= kindMask
    incidentKinds[c] |= kindMask

    const ai = a * 3
    const bi = b * 3
    const ci = c * 3
    const abx = result.positions[bi]! - result.positions[ai]!
    const aby = result.positions[bi + 1]! - result.positions[ai + 1]!
    const abz = result.positions[bi + 2]! - result.positions[ai + 2]!
    const acx = result.positions[ci]! - result.positions[ai]!
    const acy = result.positions[ci + 1]! - result.positions[ai + 1]!
    const acz = result.positions[ci + 2]! - result.positions[ai + 2]!
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    for (const vertex of [a, b, c]) {
      const target = vertex * 3
      geometric[target] += nx
      geometric[target + 1] += ny
      geometric[target + 2] += nz
    }
  }

  // CSG may duplicate an intersection vertex when two material groups meet.
  // Quantised world-local positions reunite those copies for shading without
  // changing indices or the intentionally split interior/emissive surfaces.
  const POSITION_EPSILON = 1e-4
  const groups = new Map<string, number[]>()
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (result.interiorVertices[vertex] !== 0 || incidentKinds[vertex] === 0) continue
    const source = vertex * 3
    const key = `${Math.round(result.positions[source]! / POSITION_EPSILON)}:` +
      `${Math.round(result.positions[source + 1]! / POSITION_EPSILON)}:` +
      `${Math.round(result.positions[source + 2]! / POSITION_EPSILON)}`
    const group = groups.get(key)
    if (group) group.push(vertex)
    else groups.set(key, [vertex])
  }

  const normals = result.normals.slice()
  let changed = false
  for (const vertices of groups.values()) {
    let mask = 0
    for (const vertex of vertices) mask |= incidentKinds[vertex]!
    if (mask !== 3) continue
    let nx = 0
    let ny = 0
    let nz = 0
    for (const vertex of vertices) {
      const source = vertex * 3
      nx += geometric[source]!
      ny += geometric[source + 1]!
      nz += geometric[source + 2]!
    }
    const length = Math.hypot(nx, ny, nz)
    if (length < 1e-8) continue
    nx /= length
    ny /= length
    nz /= length
    for (const vertex of vertices) {
      const target = vertex * 3
      normals[target] = nx
      normals[target + 1] = ny
      normals[target + 2] = nz
    }
    changed = true
  }
  return changed ? { ...result, normals } : result
}

/**
 * Metres. A triangle longer than this in its longest edge is longer than any
 * grid cell the terrain is compiled at, so it can only have come from an
 * intersection curve rather than from the base grid.
 */
const NEEDLE_EDGE_METRES = 3
/**
 * Ratio of a triangle's height to its longest edge, below which it is a
 * needle. An equilateral triangle scores 0.87; a grid quad's halves score 0.7;
 * the spikes this exists to remove score under 0.01.
 */
const NEEDLE_THINNESS = 0.03

/**
 * Exact triangle intersections can leave zero-area numerical shards, especially
 * after a seam coordinate is snapped to its authoritative section plane. They
 * carry no visible surface but fail the authoritative mesh validator and can
 * otherwise put a section into an endless rebuild loop.
 *
 * They can also leave shards that are *not* numerically zero: where a cutter's
 * face runs nearly tangent to the grid, the intersection can produce a triangle
 * metres long and centimetres wide. Those have plenty of area to survive an
 * area test, and they are the bright needles seen hanging in the air off every
 * authored landform — lit edge-on by a low sun, against fog, at ten times the
 * brightness of anything behind them. Length alone is not the tell and thinness
 * alone is not either: the seam between two solids is legitimately made of thin
 * triangles, and they are short. Both together is.
 */
export function removeBooleanSliverTriangles(
  result: BooleanMeshBuffers,
  minimumDoubleAreaSquared = 2e-12,
): BooleanMeshBuffers {
  const indices: number[] = []
  const triangleSurfaceKinds: number[] = []
  for (let offset = 0; offset < result.indices.length; offset += 3) {
    const a = result.indices[offset]!
    const b = result.indices[offset + 1]!
    const c = result.indices[offset + 2]!
    if (a === b || b === c || c === a) continue
    const ai = a * 3
    const bi = b * 3
    const ci = c * 3
    const abx = result.positions[bi]! - result.positions[ai]!
    const aby = result.positions[bi + 1]! - result.positions[ai + 1]!
    const abz = result.positions[bi + 2]! - result.positions[ai + 2]!
    const acx = result.positions[ci]! - result.positions[ai]!
    const acy = result.positions[ci + 1]! - result.positions[ai + 1]!
    const acz = result.positions[ci + 2]! - result.positions[ai + 2]!
    const crossX = aby * acz - abz * acy
    const crossY = abz * acx - abx * acz
    const crossZ = abx * acy - aby * acx
    const doubleAreaSquared = crossX * crossX + crossY * crossY + crossZ * crossZ
    if (doubleAreaSquared < minimumDoubleAreaSquared) continue

    const bcx = result.positions[ci]! - result.positions[bi]!
    const bcy = result.positions[ci + 1]! - result.positions[bi + 1]!
    const bcz = result.positions[ci + 2]! - result.positions[bi + 2]!
    const longestEdgeSquared = Math.max(
      abx * abx + aby * aby + abz * abz,
      acx * acx + acy * acy + acz * acz,
      bcx * bcx + bcy * bcy + bcz * bcz,
    )
    if (longestEdgeSquared > NEEDLE_EDGE_METRES * NEEDLE_EDGE_METRES) {
      // Height above the longest edge, over that edge's length. Both sides are
      // squared, so no square roots are taken on the hot path.
      const thinnessSquared = doubleAreaSquared / (longestEdgeSquared * longestEdgeSquared)
      if (thinnessSquared < NEEDLE_THINNESS * NEEDLE_THINNESS) continue
    }
    indices.push(a, b, c)
    triangleSurfaceKinds.push(
      result.triangleSurfaceKinds?.[offset / 3] ?? TERRAIN_SURFACE_TRIANGLE,
    )
  }
  if (indices.length === result.indices.length) return result
  return {
    ...result,
    indices: Uint32Array.from(indices),
    triangleSurfaceKinds: result.triangleSurfaceKinds
      ? Uint8Array.from(triangleSurfaceKinds)
      : undefined,
  }
}

/**
 * Assigns every post-CSG triangle to exactly one streamed section.
 *
 * Additive mesh operands cross section boundaries. Each worker must evaluate
 * the complete solid so its Boolean intersection is correct, but returning the
 * complete operand from every touched worker draws several coincident copies.
 * A later subtractor then opens only the owning copy while neighbours continue
 * to render solid rock over the portal. Ownership by world-space centroid
 * partitions the identical operand triangles without clipping their natural
 * edges or introducing an authored box into the formation.
 */
function retainOwnedSectionTriangles(
  result: BooleanMeshBuffers,
  sectionOriginX: number,
  sectionOriginZ: number,
  sectionSize: number,
): BooleanMeshBuffers {
  const sectionX = Math.round(sectionOriginX / sectionSize)
  const sectionZ = Math.round(sectionOriginZ / sectionSize)
  const boundaryBias = Math.max(1e-6, sectionSize * 1e-7)
  const ownedIndices: number[] = []
  const ownedSurfaceKinds: number[] = []

  for (let offset = 0; offset < result.indices.length; offset += 3) {
    const a = result.indices[offset]!
    const b = result.indices[offset + 1]!
    const c = result.indices[offset + 2]!
    const localX = (
      result.positions[a * 3]! +
      result.positions[b * 3]! +
      result.positions[c * 3]!
    ) / 3
    const localZ = (
      result.positions[a * 3 + 2]! +
      result.positions[b * 3 + 2]! +
      result.positions[c * 3 + 2]!
    ) / 3
    const ownerX = Math.floor(
      (sectionOriginX + localX + boundaryBias) / sectionSize,
    )
    const ownerZ = Math.floor(
      (sectionOriginZ + localZ + boundaryBias) / sectionSize,
    )
    if (ownerX === sectionX && ownerZ === sectionZ) {
      ownedIndices.push(a, b, c)
      ownedSurfaceKinds.push(
        result.triangleSurfaceKinds?.[offset / 3] ?? TERRAIN_SURFACE_TRIANGLE,
      )
    }
  }
  if (ownedIndices.length === result.indices.length) return result

  // Compact immediately. Leaving every rejected operand vertex in the
  // attribute arrays fixes overdraw but keeps the same cold-load upload cost
  // and expands each section's culling bounds back over the whole landmark.
  const vertexMap = new Map<number, number>()
  const positions: number[] = []
  const normals: number[] = []
  const interior: number[] = []
  const indices: number[] = []
  for (const sourceVertex of ownedIndices) {
    let targetVertex = vertexMap.get(sourceVertex)
    if (targetVertex === undefined) {
      targetVertex = positions.length / 3
      vertexMap.set(sourceVertex, targetVertex)
      const sourceOffset = sourceVertex * 3
      positions.push(
        result.positions[sourceOffset]!,
        result.positions[sourceOffset + 1]!,
        result.positions[sourceOffset + 2]!,
      )
      normals.push(
        result.normals[sourceOffset]!,
        result.normals[sourceOffset + 1]!,
        result.normals[sourceOffset + 2]!,
      )
      interior.push(result.interiorVertices[sourceVertex] ?? 0)
    }
    indices.push(targetVertex)
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    interiorVertices: Uint8Array.from(interior),
    triangleSurfaceKinds: result.triangleSurfaceKinds
      ? Uint8Array.from(ownedSurfaceKinds)
      : undefined,
  }
}

function isUsableBooleanResult(result: BooleanMeshBuffers): boolean {
  const vertexCount = result.positions.length / 3
  if (vertexCount < 3 || result.indices.length < 3) return false
  for (const value of result.positions) {
    if (!Number.isFinite(value)) return false
  }
  for (const index of result.indices) {
    if (index >= vertexCount) return false
  }
  return true
}

function isDegenerateTriangle(
  positions: BufferAttribute,
  triangle: number[],
): boolean {
  const [a, b, c] = triangle
  const abx = positions.getX(b) - positions.getX(a)
  const aby = positions.getY(b) - positions.getY(a)
  const abz = positions.getZ(b) - positions.getZ(a)
  const acx = positions.getX(c) - positions.getX(a)
  const acy = positions.getY(c) - positions.getY(a)
  const acz = positions.getZ(c) - positions.getZ(a)
  const crossX = aby * acz - abz * acy
  const crossY = abz * acx - abx * acz
  const crossZ = abx * acy - aby * acx
  return crossX * crossX + crossY * crossY + crossZ * crossZ < 1e-12
}

interface BoundaryEdge {
  a: number
  b: number
  count: number
}

function findBoundaryEdges(indices: Uint32Array): BoundaryEdge[] {
  const edges = new Map<string, BoundaryEdge>()
  for (let index = 0; index < indices.length; index += 3) {
    addEdge(edges, indices[index], indices[index + 1])
    addEdge(edges, indices[index + 1], indices[index + 2])
    addEdge(edges, indices[index + 2], indices[index])
  }
  return [...edges.values()].filter((edge) => edge.count === 1)
}

function addEdge(edges: Map<string, BoundaryEdge>, a: number, b: number): void {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`
  const existing = edges.get(key)
  if (existing) existing.count += 1
  else edges.set(key, { a, b, count: 1 })
}

/**
 * CSG intersections against independently closed section solids can differ by
 * tiny floating-point amounts. Snapping only vertices already very near an
 * ownership plane makes neighboring sections share the exact same plane while
 * leaving portal and interior topology untouched.
 */
function snapSectionBoundaryVertices(
  positions: Float32Array,
  sectionSize: number,
): void {
  const epsilon = Math.max(1e-4, sectionSize * 1e-5)
  for (let offset = 0; offset < positions.length; offset += 3) {
    if (Math.abs(positions[offset]) <= epsilon) positions[offset] = 0
    else if (Math.abs(positions[offset] - sectionSize) <= epsilon) {
      positions[offset] = sectionSize
    }
    if (Math.abs(positions[offset + 2]) <= epsilon) positions[offset + 2] = 0
    else if (Math.abs(positions[offset + 2] - sectionSize) <= epsilon) {
      positions[offset + 2] = sectionSize
    }
  }
}
