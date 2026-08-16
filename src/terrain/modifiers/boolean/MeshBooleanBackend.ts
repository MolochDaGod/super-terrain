import {
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg'
import type { BooleanSubtractModifier } from '../types'
import { transformedTunnel } from '../transform'
import { tunnelPathPoints } from '../tunnel'

export interface BooleanMeshBuffers {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  interiorVertices: Uint8Array
}

export interface MeshBooleanBackend {
  readonly id: string
  subtract(
    target: BooleanMeshBuffers,
    modifiers: BooleanSubtractModifier[],
    sectionOriginX: number,
    sectionOriginZ: number,
    sectionSize: number,
    detail: number,
  ): BooleanMeshBuffers
}

/**
 * Worker-only volumetric CSG backend. The open authoring surface is temporarily
 * closed into a solid, tunnel volumes are subtracted with BVH-accelerated CSG,
 * then artificial section-side and bottom faces are stripped from the result.
 * The retained output contains the split portal surface and connected cave
 * walls/ceiling/floor produced by the boolean itself.
 */
export class BvhCsgTunnelBooleanBackend implements MeshBooleanBackend {
  readonly id = 'bvh-csg-tunnel-v3'
  private readonly surfaceMaterial = new MeshBasicMaterial()
  private readonly closureMaterial = new MeshBasicMaterial()
  private readonly interiorMaterial = new MeshBasicMaterial()

  subtract(
    target: BooleanMeshBuffers,
    modifiers: BooleanSubtractModifier[],
    sectionOriginX: number,
    sectionOriginZ: number,
    sectionSize: number,
    detail: number,
  ): BooleanMeshBuffers {
    if (modifiers.length === 0) return target

    const evaluator = new Evaluator()
    evaluator.attributes = ['position', 'normal']
    evaluator.useGroups = true
    let result = this.createTerrainSolid(target, sectionSize)

    for (const modifier of modifiers) {
      const tunnel = transformedTunnel(modifier)
      for (const [start, end] of tunnelSegments(
        tunnel,
        sectionOriginX,
        sectionOriginZ,
      )) {
        const cutter = this.createCapsuleBrush(
          start,
          end,
          tunnel.radius,
          detail,
        )
        const previous = result
        result = evaluator.evaluate(previous, cutter, SUBTRACTION)
        if (previous !== result) previous.geometry.dispose()
        cutter.geometry.dispose()
      }
    }

    const extracted = this.extractVisibleGeometry(result)
    snapSectionBoundaryVertices(extracted.positions, sectionSize)
    result.geometry.dispose()
    return extracted
  }

  private createTerrainSolid(
    target: BooleanMeshBuffers,
    sectionSize: number,
  ): Brush {
    const vertexCount = target.positions.length / 3
    let minimumY = Infinity
    for (let offset = 1; offset < target.positions.length; offset += 3) {
      minimumY = Math.min(minimumY, target.positions[offset])
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
    for (const edge of findBoundaryEdges(target.indices)) {
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

  private createCapsuleBrush(
    start: Vector3,
    end: Vector3,
    radius: number,
    detail: number,
  ): Brush {
    const direction = end.clone().sub(start)
    const distance = Math.max(0.1, direction.length())
    direction.normalize()
    const geometry = new CapsuleGeometry(
      radius,
      distance,
      Math.max(4, Math.round(5 * detail)),
      Math.max(8, Math.round(12 * detail)),
    )
    geometry.deleteAttribute('uv')
    geometry.clearGroups()
    geometry.addGroup(0, geometry.getIndex()?.count ?? 0, 0)
    const brush = new Brush(geometry, this.interiorMaterial)
    brush.position.copy(start).add(end).multiplyScalar(0.5)
    brush.quaternion.copy(
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction),
    )
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
    const vertexMap = new Map<string, number>()

    for (const group of geometry.groups) {
      const material = materials[group.materialIndex ?? 0]
      if (material === this.closureMaterial) continue
      const isInterior = material === this.interiorMaterial
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
        for (const sourceVertex of triangle) {
          const mapKey = `${sourceVertex}:${isInterior ? 1 : 0}`
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
            interior.push(isInterior ? 1 : 0)
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
    }
  }
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

function tunnelSegments(
  modifier: BooleanSubtractModifier,
  originX: number,
  originZ: number,
): [Vector3, Vector3][] {
  const points = tunnelPathPoints(modifier).map(
    (point) => new Vector3(point.x - originX, point.y, point.z - originZ),
  )
  return points.slice(0, -1).map((point, index) => [point, points[index + 1]])
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
