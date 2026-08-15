import type { AABB, Vec3Like } from '../core/types'

export type BrushMode = 'raise' | 'lower' | 'smooth' | 'flatten'

interface ModifierBase {
  id: string
  enabled: boolean
  priority: number
  bounds: AABB
}

export interface BrushStrokeModifier extends ModifierBase {
  type: 'brush-stroke'
  mode: BrushMode
  radius: number
  strength: number
  falloff: number
  targetY?: number
  points: Vec3Like[]
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

export interface BooleanSubtractModifier extends ModifierBase {
  type: 'boolean-subtract'
  center: Vec3Like
  radius: number
  length: number
  direction: { x: number; z: number }
  backend: string
}

export type TerrainModifier =
  | BrushStrokeModifier
  | NoiseModifier
  | FieldDisplacementModifier
  | RemeshModifier
  | TessellateModifier
  | BooleanSubtractModifier

export interface ModifierContext {
  sectionBounds: AABB
  revision: number
  signal?: AbortSignal
}

export interface ModifierEvaluator {
  evaluate(context: ModifierContext): void | Promise<void>
}
