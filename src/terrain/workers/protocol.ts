import type { CompiledSection, SectionKey } from '../core/types'
import type { TerrainConfig } from '../config'
import type { TerrainSectionSourceSnapshot } from '../mesh/EditableMesh'
import type {
  BrushStrokeModifier,
  TerrainModifier,
} from '../modifiers/types'

/**
 * A brush stroke on the wire, with its dabs moved into a shared Float32Array.
 *
 * Derived from the modifier rather than restated field by field. The explicit
 * list this replaces was an allowlist that silently dropped anything not named
 * in it, so adding a property to `BrushStrokeModifier` compiled clean, worked
 * in the viewport preview, and then quietly did nothing in the worker.
 */
export type BrushModifierDescriptor = Omit<BrushStrokeModifier, 'points'> & {
  pointOffset: number
  pointCount: number
}

export type NonBrushModifier = Exclude<TerrainModifier, { type: 'brush-stroke' }>
export type WorkerModifierDescriptor = BrushModifierDescriptor | NonBrushModifier

export interface ModifierPacket {
  descriptors: WorkerModifierDescriptor[]
  brushPoints: Float32Array
}

export interface CompileSectionRequest {
  kind: 'compile-section'
  jobId: number
  key: SectionKey
  revision: number
  priority: number
  config: Pick<
    TerrainConfig,
    'sectionSize' | 'lodResolutions' | 'seed' | 'operationHalo'
  > &
    // Optional so a request built before the profile existed still compiles the
    // natural landform model rather than failing to type-check a test fixture.
    Partial<Pick<TerrainConfig, 'worldProfile'>>
  /**
   * Optional subset of LOD levels to return. Exact Boolean topology can be
   * evaluated directly on the finest requested screen-error grid; sampled
   * brush strokes still simplify from LOD0 so a small edit cannot disappear.
   */
  levels?: readonly number[]
  /** Omitted requests retain backwards-compatible procedural generation. */
  source?: TerrainSectionSourceSnapshot
  modifiers: ModifierPacket
}

export interface CompileSectionSuccess {
  kind: 'compile-success'
  jobId: number
  key: SectionKey
  revision: number
  compiled: CompiledSection
}

/**
 * The worker has reached this request and is about to enter the synchronous
 * compiler. Requests posted behind it remain worker-buffered and do not emit
 * this message until their own compilation really begins.
 */
export interface CompileSectionStarted {
  kind: 'compile-started'
  jobId: number
  key: SectionKey
  revision: number
}

export interface CompileSectionFailure {
  kind: 'compile-failure'
  jobId: number
  key: SectionKey
  revision: number
  error: string
}

export type TerrainWorkerRequest = CompileSectionRequest
export type TerrainWorkerResponse =
  | CompileSectionStarted
  | CompileSectionSuccess
  | CompileSectionFailure

export function encodeModifiers(modifiers: TerrainModifier[]): ModifierPacket {
  let pointCount = 0
  for (const modifier of modifiers) {
    if (modifier.type === 'brush-stroke') pointCount += modifier.points.length
  }

  const brushPoints = new Float32Array(pointCount * 7)
  const descriptors: WorkerModifierDescriptor[] = []
  let pointCursor = 0

  for (const modifier of modifiers) {
    if (modifier.type !== 'brush-stroke') {
      descriptors.push(modifier)
      continue
    }
    const pointOffset = pointCursor
    for (const point of modifier.points) {
      const offset = pointCursor * 7
      brushPoints[offset] = point.x
      brushPoints[offset + 1] = point.y
      brushPoints[offset + 2] = point.z
      brushPoints[offset + 3] = point.normal?.x ?? 0
      brushPoints[offset + 4] = point.normal?.y ?? 1
      brushPoints[offset + 5] = point.normal?.z ?? 0
      brushPoints[offset + 6] = point.weight ?? 1
      pointCursor += 1
    }
    const { points: _points, ...rest } = modifier
    descriptors.push({
      ...rest,
      pointOffset,
      pointCount: modifier.points.length,
    })
  }
  return { descriptors, brushPoints }
}

export function decodeModifiers(packet: ModifierPacket): TerrainModifier[] {
  return packet.descriptors.map((descriptor) => {
    if (descriptor.type !== 'brush-stroke') return descriptor
    const { pointOffset, pointCount, ...brush } = descriptor
    const points = []
    for (let point = 0; point < pointCount; point += 1) {
      const offset = (pointOffset + point) * 7
      points.push({
        x: packet.brushPoints[offset],
        y: packet.brushPoints[offset + 1],
        z: packet.brushPoints[offset + 2],
        normal: {
          x: packet.brushPoints[offset + 3],
          y: packet.brushPoints[offset + 4],
          z: packet.brushPoints[offset + 5],
        },
        weight: packet.brushPoints[offset + 6],
      })
    }
    return {
      ...brush,
      points,
    }
  })
}

export function compiledTransferables(compiled: CompiledSection): Transferable[] {
  const transferables: Transferable[] = []
  for (const lod of compiled.lods) {
    transferables.push(
      lod.positions.buffer,
      ...(lod.stableVertexIds ? [lod.stableVertexIds.buffer] : []),
      ...(lod.sourceVertexIndices ? [lod.sourceVertexIndices.buffer] : []),
      lod.normals.buffer,
      lod.colors.buffer,
      ...(lod.surfaceFields?.map((field) => field.buffer) ?? []),
      ...(lod.paintWeights ? [lod.paintWeights.buffer] : []),
      lod.indices.buffer,
    )
  }
  return transferables
}

export function sourceTransferables(
  source: TerrainSectionSourceSnapshot | undefined,
): Transferable[] {
  if (!source || source.kind === 'procedural') return []
  const buffers = new Set<ArrayBuffer>()
  const add = (view: ArrayBufferView) => buffers.add(view.buffer as ArrayBuffer)
  add(source.positions)
  add(source.triangles)
  add(source.vertexIds)
  add(source.triangleIds)
  add(source.boundaryEdgeMasks)
  add(source.ownedBoundaryEdgeMasks)
  add(source.boundaryWeldKeys)
  for (const attribute of source.vertexAttributes) add(attribute.values)
  for (const attribute of source.triangleAttributes) add(attribute.values)
  return [...buffers]
}
