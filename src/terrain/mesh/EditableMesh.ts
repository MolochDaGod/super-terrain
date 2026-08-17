import type { AABB, SectionKey, Vec3Like } from '../core/types'
import { buildSectionBoundaryData } from '../partition/boundary'
import type { SectionBoundaryWorldRange } from '../partition/boundary'
import { MeshSpatialIndex, type MeshQueryStats } from './MeshSpatialIndex'
import {
  validateMeshData,
  type MeshBoundaryMode,
  type MeshValidationOptions,
} from './MeshValidation'

export interface MeshAttributeSnapshot {
  name: string
  itemSize: number
  values: Float32Array
}

export interface EditableMeshSnapshot {
  sourceId: string
  boundaryMode: MeshBoundaryMode
  positions: Float32Array
  triangles: Uint32Array
  vertexIds: Uint32Array
  triangleIds: Uint32Array
  vertexAttributes: readonly MeshAttributeSnapshot[]
  triangleAttributes: readonly MeshAttributeSnapshot[]
}

export interface ProceduralSectionSourceSnapshot {
  kind: 'procedural'
  seed: number
}

export interface EditableSectionSourceSnapshot extends EditableMeshSnapshot {
  kind: 'editable-mesh'
  revision: number
  boundaryEdgeMasks: Uint8Array
  ownedBoundaryEdgeMasks: Uint8Array
  boundaryWeldKeys: Uint32Array
}

export type TerrainSectionSourceSnapshot =
  | ProceduralSectionSourceSnapshot
  | EditableSectionSourceSnapshot

export interface EditableMeshOptions {
  sourceId?: string
  boundaryMode?: MeshBoundaryMode
  validation?: Omit<MeshValidationOptions, 'boundaryMode'>
  vertexIds?: Uint32Array
  triangleIds?: Uint32Array
}

export interface MeshPatch {
  positions: Float32Array
  triangles: Uint32Array
  /** `added` is compact for isolated patches; `combined` can stitch to old vertices. */
  triangleIndexSpace?: 'added' | 'combined'
  removeTriangles?: Uint32Array
  vertexIds?: Uint32Array
  triangleIds?: Uint32Array
  vertexAttributes?: ReadonlyMap<string, Float32Array>
  triangleAttributes?: ReadonlyMap<string, Float32Array>
}

interface AdjacencyData {
  vertexOffsets: Uint32Array
  vertexNeighbors: Uint32Array
  triangleOffsets: Uint32Array
  triangleNeighbors: Uint32Array
  boundaryVertices: Uint8Array
}

let nextFallbackSourceId = 1

/**
 * Authoritative, renderer-neutral source topology for one terrain section.
 * Derived adjacency and spatial acceleration are lazy and disposable.
 */
export class EditableMesh {
  positions: Float32Array
  triangles: Uint32Array
  vertexIds: Uint32Array
  triangleIds: Uint32Array
  readonly sourceId: string
  readonly boundaryMode: MeshBoundaryMode
  readonly vertexAttributes = new Map<string, Float32Array>()
  readonly triangleAttributes = new Map<string, Float32Array>()
  private readonly vertexAttributeSizes = new Map<string, number>()
  private readonly triangleAttributeSizes = new Map<string, number>()
  private readonly validationOptions: Omit<MeshValidationOptions, 'boundaryMode'>
  private adjacency?: AdjacencyData
  private spatialIndex?: MeshSpatialIndex
  private vertexIdLookup?: Map<number, number>
  private triangleIdLookup?: Map<number, number>
  private nextVertexId = 1
  private nextTriangleId = 1

  constructor(
    positions = new Float32Array(),
    triangles = new Uint32Array(),
    options: EditableMeshOptions = {},
  ) {
    this.sourceId = options.sourceId ?? `editable-${nextFallbackSourceId++}`
    this.boundaryMode = options.boundaryMode ?? 'allow'
    this.validationOptions = { ...options.validation }
    const validation = validateMeshData(positions, triangles, {
      ...this.validationOptions,
      boundaryMode: this.boundaryMode,
    })
    if (!validation.valid) throw new Error(validation.errors.join('; '))
    this.positions = positions
    this.triangles = triangles
    this.vertexIds = options.vertexIds ?? sequentialIds(positions.length / 3)
    this.triangleIds = options.triangleIds ?? sequentialIds(triangles.length / 3)
    validateStableIds(this.vertexIds, this.vertexCount, 'vertex')
    validateStableIds(this.triangleIds, this.triangleCount, 'triangle')
    this.nextVertexId = nextStableId(this.vertexIds)
    this.nextTriangleId = nextStableId(this.triangleIds)
  }

  get vertexCount(): number {
    return this.positions.length / 3
  }

  get triangleCount(): number {
    return this.triangles.length / 3
  }

  get byteLength(): number {
    let bytes =
      this.positions.byteLength +
      this.triangles.byteLength +
      this.vertexIds.byteLength +
      this.triangleIds.byteLength +
      (this.adjacency ? adjacencyBytes(this.adjacency) : 0) +
      (this.spatialIndex?.byteLength ?? 0)
    for (const value of this.vertexAttributes.values()) bytes += value.byteLength
    for (const value of this.triangleAttributes.values()) bytes += value.byteLength
    return bytes
  }

  setVertexAttribute(name: string, values: Float32Array): void {
    const itemSize = attributeItemSize(name, values.length, this.vertexCount)
    assertFiniteAttribute(name, values)
    this.vertexAttributes.set(name, values)
    this.vertexAttributeSizes.set(name, itemSize)
  }

  setTriangleAttribute(name: string, values: Float32Array): void {
    const itemSize = attributeItemSize(name, values.length, this.triangleCount)
    assertFiniteAttribute(name, values)
    this.triangleAttributes.set(name, values)
    this.triangleAttributeSizes.set(name, itemSize)
  }

  getVertexAttributeSize(name: string): number | undefined {
    return this.vertexAttributeSizes.get(name)
  }

  getTriangleAttributeSize(name: string): number | undefined {
    return this.triangleAttributeSizes.get(name)
  }

  getVertexNeighbors(vertex: number): Uint32Array {
    assertElementIndex(vertex, this.vertexCount, 'vertex')
    const adjacency = this.getAdjacency()
    return adjacency.vertexNeighbors.slice(
      adjacency.vertexOffsets[vertex],
      adjacency.vertexOffsets[vertex + 1],
    )
  }

  getTriangleNeighbors(triangle: number): Uint32Array {
    assertElementIndex(triangle, this.triangleCount, 'triangle')
    const adjacency = this.getAdjacency()
    return adjacency.triangleNeighbors.slice(
      adjacency.triangleOffsets[triangle],
      adjacency.triangleOffsets[triangle + 1],
    )
  }

  isBoundaryVertex(vertex: number): boolean {
    assertElementIndex(vertex, this.vertexCount, 'vertex')
    return this.getAdjacency().boundaryVertices[vertex] === 1
  }

  vertexIndexForId(id: number): number | undefined {
    this.vertexIdLookup ??= idLookup(this.vertexIds)
    return this.vertexIdLookup.get(id)
  }

  triangleIndexForId(id: number): number | undefined {
    this.triangleIdLookup ??= idLookup(this.triangleIds)
    return this.triangleIdLookup.get(id)
  }

  updateVertexPositions(indices: Uint32Array, positions: Float32Array): void {
    if (positions.length !== indices.length * 3) {
      throw new Error('Updated positions must contain one xyz value per vertex index')
    }
    for (let update = 0; update < indices.length; update += 1) {
      const vertex = indices[update]
      assertElementIndex(vertex, this.vertexCount, 'vertex')
      const source = update * 3
      const x = positions[source]
      const y = positions[source + 1]
      const z = positions[source + 2]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`Updated vertex ${vertex} is not finite`)
      }
    }
    for (let update = 0; update < indices.length; update += 1) {
      const vertex = indices[update]
      const source = update * 3
      const target = vertex * 3
      this.positions[target] = positions[source]
      this.positions[target + 1] = positions[source + 1]
      this.positions[target + 2] = positions[source + 2]
    }
    this.invalidateGeometryDerivedData()
  }

  updateVertexById(id: number, position: Vec3Like): boolean {
    const index = this.vertexIndexForId(id)
    if (index === undefined) return false
    this.updateVertexPositions(
      Uint32Array.of(index),
      Float32Array.of(position.x, position.y, position.z),
    )
    return true
  }

  queryTriangles(bounds: AABB, stats?: MeshQueryStats): Uint32Array {
    this.spatialIndex ??= new MeshSpatialIndex(this.positions, this.triangles)
    return this.spatialIndex.query(bounds, stats)
  }

  extractRegion(bounds: AABB): EditableMesh {
    const selectedTriangles = this.queryTriangles(bounds)
    const vertexMap = new Map<number, number>()
    const sourceVertices: number[] = []
    const positions: number[] = []
    const triangles: number[] = []
    const triangleIds = new Uint32Array(selectedTriangles.length)

    for (let selected = 0; selected < selectedTriangles.length; selected += 1) {
      const triangle = selectedTriangles[selected]
      triangleIds[selected] = this.triangleIds[triangle]
      for (let corner = 0; corner < 3; corner += 1) {
        const sourceVertex = this.triangles[triangle * 3 + corner]
        let targetVertex = vertexMap.get(sourceVertex)
        if (targetVertex === undefined) {
          targetVertex = vertexMap.size
          vertexMap.set(sourceVertex, targetVertex)
          sourceVertices.push(sourceVertex)
          const sourcePosition = sourceVertex * 3
          positions.push(
            this.positions[sourcePosition],
            this.positions[sourcePosition + 1],
            this.positions[sourcePosition + 2],
          )
        }
        triangles.push(targetVertex)
      }
    }

    const region = new EditableMesh(
      Float32Array.from(positions),
      Uint32Array.from(triangles),
      {
        sourceId: this.sourceId,
        boundaryMode: 'allow',
        vertexIds: Uint32Array.from(
          sourceVertices.map((vertex) => this.vertexIds[vertex]),
        ),
        triangleIds,
      },
    )
    for (const [name, values] of this.vertexAttributes) {
      const itemSize = this.vertexAttributeSizes.get(name)!
      region.setVertexAttribute(
        name,
        selectAttribute(values, itemSize, sourceVertices),
      )
    }
    for (const [name, values] of this.triangleAttributes) {
      const itemSize = this.triangleAttributeSizes.get(name)!
      region.setTriangleAttribute(
        name,
        selectAttribute(values, itemSize, selectedTriangles),
      )
    }
    return region
  }

  applyPatch(patch: MeshPatch): void {
    if (patch.positions.length % 3 !== 0 || patch.triangles.length % 3 !== 0) {
      throw new Error('Mesh patch buffers must be xyz and triangle aligned')
    }
    const removed = new Set(patch.removeTriangles ?? [])
    for (const triangle of removed) {
      assertElementIndex(triangle, this.triangleCount, 'triangle')
    }
    const retainedTriangles: number[] = []
    const retainedTriangleIndices: number[] = []
    for (let triangle = 0; triangle < this.triangleCount; triangle += 1) {
      if (removed.has(triangle)) continue
      const offset = triangle * 3
      retainedTriangles.push(
        this.triangles[offset],
        this.triangles[offset + 1],
        this.triangles[offset + 2],
      )
      retainedTriangleIndices.push(triangle)
    }

    const addedVertexCount = patch.positions.length / 3
    const addedTriangleCount = patch.triangles.length / 3
    const vertexOffset = this.vertexCount
    const nextPositions = appendTyped(this.positions, patch.positions)
    const nextTriangles = new Uint32Array(
      retainedTriangles.length + patch.triangles.length,
    )
    nextTriangles.set(retainedTriangles)
    const combinedIndexSpace = patch.triangleIndexSpace === 'combined'
    for (let index = 0; index < patch.triangles.length; index += 1) {
      const sourceIndex = patch.triangles[index]
      const maximum = combinedIndexSpace
        ? this.vertexCount + addedVertexCount
        : addedVertexCount
      if (sourceIndex >= maximum) {
        throw new Error(
          `Patch triangle index ${sourceIndex} exceeds its ${combinedIndexSpace ? 'combined' : 'added'} vertex space`,
        )
      }
      nextTriangles[retainedTriangles.length + index] = combinedIndexSpace
        ? sourceIndex
        : sourceIndex + vertexOffset
    }

    const addedVertexIds = patch.vertexIds ?? this.allocateVertexIds(addedVertexCount)
    const addedTriangleIds =
      patch.triangleIds ?? this.allocateTriangleIds(addedTriangleCount)
    validateStableIds(addedVertexIds, addedVertexCount, 'patch vertex')
    validateStableIds(addedTriangleIds, addedTriangleCount, 'patch triangle')
    assertDisjointIds(this.vertexIds, addedVertexIds, 'vertex')
    const retainedIds = Uint32Array.from(
      retainedTriangleIndices.map((triangle) => this.triangleIds[triangle]),
    )
    assertDisjointIds(this.triangleIds, addedTriangleIds, 'triangle')
    const nextVertexIds = appendTyped(this.vertexIds, addedVertexIds)
    const nextTriangleIds = appendTyped(retainedIds, addedTriangleIds)

    const validation = validateMeshData(nextPositions, nextTriangles, {
      ...this.validationOptions,
      boundaryMode: this.boundaryMode,
    })
    if (!validation.valid) throw new Error(validation.errors.join('; '))

    const nextVertexAttributes = patchAttributes(
      this.vertexAttributes,
      this.vertexAttributeSizes,
      patch.vertexAttributes,
      this.vertexCount,
      addedVertexCount,
    )
    const nextTriangleAttributes = patchTriangleAttributes(
      this.triangleAttributes,
      this.triangleAttributeSizes,
      patch.triangleAttributes,
      retainedTriangleIndices,
      addedTriangleCount,
    )

    this.positions = nextPositions
    this.triangles = nextTriangles
    this.vertexIds = nextVertexIds
    this.triangleIds = nextTriangleIds
    replaceMap(this.vertexAttributes, nextVertexAttributes.values)
    replaceMap(this.vertexAttributeSizes, nextVertexAttributes.sizes)
    replaceMap(this.triangleAttributes, nextTriangleAttributes.values)
    replaceMap(this.triangleAttributeSizes, nextTriangleAttributes.sizes)
    this.nextVertexId = Math.max(this.nextVertexId, nextStableId(this.vertexIds))
    this.nextTriangleId = Math.max(this.nextTriangleId, nextStableId(this.triangleIds))
    this.invalidateTopologyDerivedData()
  }

  snapshot(copy = true): EditableMeshSnapshot {
    return {
      sourceId: this.sourceId,
      boundaryMode: this.boundaryMode,
      positions: copy ? this.positions.slice() : this.positions,
      triangles: copy ? this.triangles.slice() : this.triangles,
      vertexIds: copy ? this.vertexIds.slice() : this.vertexIds,
      triangleIds: copy ? this.triangleIds.slice() : this.triangleIds,
      vertexAttributes: snapshotAttributes(
        this.vertexAttributes,
        this.vertexAttributeSizes,
        copy,
      ),
      triangleAttributes: snapshotAttributes(
        this.triangleAttributes,
        this.triangleAttributeSizes,
        copy,
      ),
    }
  }

  clone(): EditableMesh {
    const copy = new EditableMesh(
      this.positions.slice(),
      this.triangles.slice(),
      {
        sourceId: this.sourceId,
        boundaryMode: this.boundaryMode,
        validation: this.validationOptions,
        vertexIds: this.vertexIds.slice(),
        triangleIds: this.triangleIds.slice(),
      },
    )
    for (const [name, values] of this.vertexAttributes) {
      copy.setVertexAttribute(name, values.slice())
    }
    for (const [name, values] of this.triangleAttributes) {
      copy.setTriangleAttribute(name, values.slice())
    }
    copy.nextVertexId = this.nextVertexId
    copy.nextTriangleId = this.nextTriangleId
    return copy
  }

  private getAdjacency(): AdjacencyData {
    this.adjacency ??= buildAdjacency(this.vertexCount, this.triangles)
    return this.adjacency
  }

  private allocateVertexIds(count: number): Uint32Array {
    return allocateIds(this.nextVertexId, count)
  }

  private allocateTriangleIds(count: number): Uint32Array {
    return allocateIds(this.nextTriangleId, count)
  }

  private invalidateGeometryDerivedData(): void {
    this.spatialIndex = undefined
  }

  private invalidateTopologyDerivedData(): void {
    this.adjacency = undefined
    this.spatialIndex = undefined
    this.vertexIdLookup = undefined
    this.triangleIdLookup = undefined
  }
}

export class EditableMeshSection {
  private mesh?: EditableMesh
  appliedRevision = -1
  readonly seed: number

  constructor(seed: number) {
    this.seed = seed
  }

  get procedural(): boolean {
    return this.mesh === undefined
  }

  replaceMesh(mesh: EditableMesh, revision: number): boolean {
    if (revision < this.appliedRevision) return false
    this.mesh = mesh
    this.appliedRevision = revision
    return true
  }

  restoreProcedural(revision: number): boolean {
    if (revision < this.appliedRevision) return false
    this.mesh = undefined
    this.appliedRevision = revision
    return true
  }

  cloneMesh(): EditableMesh | undefined {
    return this.mesh?.clone()
  }

  createCompileSnapshot(
    key: SectionKey,
    sectionSize: number,
    worldRange?: SectionBoundaryWorldRange,
  ): TerrainSectionSourceSnapshot {
    if (!this.mesh) return { kind: 'procedural', seed: this.seed }
    const snapshot = this.mesh.snapshot(true)
    const boundary = buildSectionBoundaryData(
      snapshot.positions,
      key,
      sectionSize,
      worldRange,
    )
    return {
      kind: 'editable-mesh',
      revision: this.appliedRevision,
      ...snapshot,
      boundaryEdgeMasks: boundary.edgeMasks,
      ownedBoundaryEdgeMasks: boundary.ownedEdgeMasks,
      boundaryWeldKeys: boundary.weldKeys,
    }
  }

  get byteLength(): number {
    return this.mesh?.byteLength ?? 0
  }
}

function buildAdjacency(vertexCount: number, triangles: Uint32Array): AdjacencyData {
  const vertexSets = Array.from({ length: vertexCount }, () => new Set<number>())
  const triangleSets = Array.from(
    { length: triangles.length / 3 },
    () => new Set<number>(),
  )
  const edgeTriangles = new Map<number, number[]>()

  for (let triangle = 0; triangle < triangles.length / 3; triangle += 1) {
    const a = triangles[triangle * 3]
    const b = triangles[triangle * 3 + 1]
    const c = triangles[triangle * 3 + 2]
    vertexSets[a].add(b).add(c)
    vertexSets[b].add(a).add(c)
    vertexSets[c].add(a).add(b)
    addEdge(edgeTriangles, vertexCount, a, b, triangle)
    addEdge(edgeTriangles, vertexCount, b, c, triangle)
    addEdge(edgeTriangles, vertexCount, c, a, triangle)
  }

  const boundaryVertices = new Uint8Array(vertexCount)
  for (const [key, owners] of edgeTriangles) {
    if (owners.length === 1) {
      const a = Math.floor(key / vertexCount)
      const b = key - a * vertexCount
      boundaryVertices[a] = 1
      boundaryVertices[b] = 1
    } else {
      for (const owner of owners) {
        for (const neighbor of owners) {
          if (owner !== neighbor) triangleSets[owner].add(neighbor)
        }
      }
    }
  }

  const vertexPacked = packSets(vertexSets)
  const trianglePacked = packSets(triangleSets)
  return {
    vertexOffsets: vertexPacked.offsets,
    vertexNeighbors: vertexPacked.values,
    triangleOffsets: trianglePacked.offsets,
    triangleNeighbors: trianglePacked.values,
    boundaryVertices,
  }
}

function addEdge(
  edges: Map<number, number[]>,
  vertexCount: number,
  a: number,
  b: number,
  triangle: number,
): void {
  const minimum = Math.min(a, b)
  const maximum = Math.max(a, b)
  const key = minimum * vertexCount + maximum
  const owners = edges.get(key)
  if (owners) owners.push(triangle)
  else edges.set(key, [triangle])
}

function packSets(sets: Set<number>[]): { offsets: Uint32Array; values: Uint32Array } {
  const offsets = new Uint32Array(sets.length + 1)
  let valueCount = 0
  for (let index = 0; index < sets.length; index += 1) {
    valueCount += sets[index].size
    offsets[index + 1] = valueCount
  }
  const values = new Uint32Array(valueCount)
  let cursor = 0
  for (const set of sets) {
    for (const value of [...set].sort((a, b) => a - b)) values[cursor++] = value
  }
  return { offsets, values }
}

function sequentialIds(count: number): Uint32Array {
  return allocateIds(1, count)
}

function allocateIds(first: number, count: number): Uint32Array {
  if (first <= 0 || first + count - 1 > 0xffff_ffff) {
    throw new Error('Stable mesh ID space exhausted')
  }
  const ids = new Uint32Array(count)
  for (let index = 0; index < count; index += 1) ids[index] = first + index
  return ids
}

function validateStableIds(ids: Uint32Array, count: number, label: string): void {
  if (ids.length !== count) {
    throw new Error(`${label} IDs do not match the element count`)
  }
  const unique = new Set<number>()
  for (const id of ids) {
    if (id === 0) throw new Error(`${label} ID 0 is reserved`)
    if (unique.has(id)) throw new Error(`Duplicate ${label} ID ${id}`)
    unique.add(id)
  }
}

function assertDisjointIds(
  existing: Uint32Array,
  added: Uint32Array,
  label: string,
): void {
  const ids = new Set(existing)
  for (const id of added) {
    if (ids.has(id)) throw new Error(`Patch reuses stable ${label} ID ${id}`)
  }
}

function nextStableId(ids: Uint32Array): number {
  let maximum = 0
  for (const id of ids) maximum = Math.max(maximum, id)
  if (maximum === 0xffff_ffff) return 0x1_0000_0000
  return maximum + 1
}

function idLookup(ids: Uint32Array): Map<number, number> {
  const lookup = new Map<number, number>()
  for (let index = 0; index < ids.length; index += 1) lookup.set(ids[index], index)
  return lookup
}

function attributeItemSize(name: string, length: number, count: number): number {
  if (count === 0) {
    if (length !== 0) throw new Error(`Attribute ${name} has data for an empty mesh`)
    return 1
  }
  if (length % count !== 0 || length === 0) {
    throw new Error(`Attribute ${name} does not match the element count`)
  }
  return length / count
}

function assertFiniteAttribute(name: string, values: Float32Array): void {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`Attribute ${name} contains a non-finite value`)
    }
  }
}

function selectAttribute(
  values: Float32Array,
  itemSize: number,
  selected: Iterable<number>,
): Float32Array {
  const result: number[] = []
  for (const index of selected) {
    const offset = index * itemSize
    for (let component = 0; component < itemSize; component += 1) {
      result.push(values[offset + component])
    }
  }
  return Float32Array.from(result)
}

function appendTyped<T extends Float32Array | Uint32Array>(first: T, second: T): T {
  const Constructor = first.constructor as new (length: number) => T
  const result = new Constructor(first.length + second.length)
  result.set(first)
  result.set(second, first.length)
  return result
}

function snapshotAttributes(
  values: ReadonlyMap<string, Float32Array>,
  sizes: ReadonlyMap<string, number>,
  copy: boolean,
): MeshAttributeSnapshot[] {
  return [...values]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, attribute]) => ({
      name,
      itemSize: sizes.get(name)!,
      values: copy ? attribute.slice() : attribute,
    }))
}

function patchAttributes(
  current: ReadonlyMap<string, Float32Array>,
  currentSizes: ReadonlyMap<string, number>,
  added: ReadonlyMap<string, Float32Array> | undefined,
  currentCount: number,
  addedCount: number,
): { values: Map<string, Float32Array>; sizes: Map<string, number> } {
  const values = new Map<string, Float32Array>()
  const sizes = new Map<string, number>()
  const names = new Set([...current.keys(), ...(added?.keys() ?? [])])
  for (const name of [...names].sort()) {
    const currentValues = current.get(name)
    const addedValues = added?.get(name)
    if (addedValues) assertFiniteAttribute(name, addedValues)
    const currentSize = currentSizes.get(name)
    const addedSize = addedValues
      ? attributeItemSize(name, addedValues.length, addedCount)
      : undefined
    const itemSize = currentSize ?? addedSize ?? 1
    if (currentSize !== undefined && addedSize !== undefined && currentSize !== addedSize) {
      throw new Error(`Patch attribute ${name} changes item size`)
    }
    const next = new Float32Array((currentCount + addedCount) * itemSize)
    if (currentValues) next.set(currentValues)
    if (addedValues) next.set(addedValues, currentCount * itemSize)
    values.set(name, next)
    sizes.set(name, itemSize)
  }
  return { values, sizes }
}

function patchTriangleAttributes(
  current: ReadonlyMap<string, Float32Array>,
  currentSizes: ReadonlyMap<string, number>,
  added: ReadonlyMap<string, Float32Array> | undefined,
  retained: readonly number[],
  addedCount: number,
): { values: Map<string, Float32Array>; sizes: Map<string, number> } {
  const values = new Map<string, Float32Array>()
  const sizes = new Map<string, number>()
  const names = new Set([...current.keys(), ...(added?.keys() ?? [])])
  for (const name of [...names].sort()) {
    const currentValues = current.get(name)
    const addedValues = added?.get(name)
    if (addedValues) assertFiniteAttribute(name, addedValues)
    const currentSize = currentSizes.get(name)
    const addedSize = addedValues
      ? attributeItemSize(name, addedValues.length, addedCount)
      : undefined
    const itemSize = currentSize ?? addedSize ?? 1
    if (currentSize !== undefined && addedSize !== undefined && currentSize !== addedSize) {
      throw new Error(`Patch attribute ${name} changes item size`)
    }
    const next = new Float32Array((retained.length + addedCount) * itemSize)
    if (currentValues) {
      for (let target = 0; target < retained.length; target += 1) {
        const sourceOffset = retained[target] * itemSize
        next.set(
          currentValues.subarray(sourceOffset, sourceOffset + itemSize),
          target * itemSize,
        )
      }
    }
    if (addedValues) next.set(addedValues, retained.length * itemSize)
    values.set(name, next)
    sizes.set(name, itemSize)
  }
  return { values, sizes }
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear()
  for (const [key, value] of source) target.set(key, value)
}

function assertElementIndex(index: number, count: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`${label} index ${index} is out of range`)
  }
}

function adjacencyBytes(adjacency: AdjacencyData): number {
  return (
    adjacency.vertexOffsets.byteLength +
    adjacency.vertexNeighbors.byteLength +
    adjacency.triangleOffsets.byteLength +
    adjacency.triangleNeighbors.byteLength +
    adjacency.boundaryVertices.byteLength
  )
}
