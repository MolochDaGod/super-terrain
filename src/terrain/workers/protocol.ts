import type { AABB, CompiledSection, SectionKey } from '../core/types'
import type { TerrainConfig } from '../config'
import type {
  BrushDomain,
  BrushMode,
  ModifierTransform,
  TerrainModifier,
} from '../modifiers/types'

export interface BrushModifierDescriptor {
  id: string
  type: 'brush-stroke'
  enabled: boolean
  priority: number
  bounds: AABB
  mode: BrushMode
  domain: BrushDomain
  transform: ModifierTransform
  radius: number
  strength: number
  falloff: number
  targetY?: number
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
  >
  modifiers: ModifierPacket
}

export interface CompileSectionSuccess {
  kind: 'compile-success'
  jobId: number
  key: SectionKey
  revision: number
  compiled: CompiledSection
}

export interface CompileSectionFailure {
  kind: 'compile-failure'
  jobId: number
  key: SectionKey
  revision: number
  error: string
}

export type TerrainWorkerRequest = CompileSectionRequest
export type TerrainWorkerResponse = CompileSectionSuccess | CompileSectionFailure

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
    descriptors.push({
      id: modifier.id,
      type: modifier.type,
      enabled: modifier.enabled,
      priority: modifier.priority,
      bounds: modifier.bounds,
      mode: modifier.mode,
      domain: modifier.domain,
      transform: modifier.transform,
      radius: modifier.radius,
      strength: modifier.strength,
      falloff: modifier.falloff,
      targetY: modifier.targetY,
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
      lod.normals.buffer,
      lod.colors.buffer,
      lod.indices.buffer,
    )
  }
  return transferables
}
