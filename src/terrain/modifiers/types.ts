import type { AABB, Vec3Like } from '../core/types'
import type { CutterVolume } from './boolean/CutterVolume'

export type BrushMode = 'raise' | 'lower' | 'smooth' | 'flatten'
export type BrushDomain = 'heightfield' | 'mesh'

export interface ModifierTransform {
  offset: Vec3Like
  yaw: number
  scale: number
}

export interface BrushSample extends Vec3Like {
  normal: Vec3Like
  /** Relative accumulated brush flow for this spatial sample. */
  weight: number
}

interface ModifierBase {
  id: string
  enabled: boolean
  priority: number
  bounds: AABB
  transform: ModifierTransform
}

export interface BrushStrokeModifier extends ModifierBase {
  type: 'brush-stroke'
  mode: BrushMode
  domain: BrushDomain
  radius: number
  strength: number
  falloff: number
  targetY?: number
  points: BrushSample[]
}

export interface NoiseModifier extends ModifierBase {
  type: 'noise'
  amplitude: number
  frequency: number
  seed: number
}

export interface FieldDisplacementModifier extends ModifierBase {
  type: 'field-displacement'
  fieldId: string
  scale: number
}

export interface RemeshModifier extends ModifierBase {
  type: 'remesh'
  center: Vec3Like
  radius: number
  targetEdgeLength: number
  minEdgeLength: number
  maxEdgeLength: number
  iterations: number
}

export interface TessellateModifier extends ModifierBase {
  type: 'tessellate'
  center: Vec3Like
  radius: number
  targetEdgeLength: number
}

export interface TunnelPortal extends Vec3Like {
  normal: Vec3Like
}

export interface BooleanSubtractModifier extends ModifierBase {
  type: 'boolean-subtract'
  shape: 'capsule-path'
  portals: [TunnelPortal, TunnelPortal]
  radius: number
  /** Distance each portal travels inward before the two ends are connected. */
  depth: number
  backend: string
}

/** A serializable set of arbitrary closed meshes removed by exact CSG. */
export interface BooleanVolumeModifier extends ModifierBase {
  type: 'boolean-volume'
  operation: 'subtract'
  volumes: CutterVolume[]
  backend: string
}

export type TerrainModifier =
  | BrushStrokeModifier
  | NoiseModifier
  | FieldDisplacementModifier
  | RemeshModifier
  | TessellateModifier
  | BooleanSubtractModifier
  | BooleanVolumeModifier

export interface ModifierContext {
  sectionBounds: AABB
  revision: number
  signal?: AbortSignal
}

export interface ModifierEvaluator {
  evaluate(context: ModifierContext): void | Promise<void>
}
