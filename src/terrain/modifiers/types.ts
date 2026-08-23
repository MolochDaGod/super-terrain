import type { AABB, Vec3Like } from '../core/types'
import type { CutterVolume } from './boolean/CutterVolume'
import type {
  TerrainMaterialSettings,
  TerrainPaintChannelId,
} from '../rendering/materialSettings'

export type BrushMode =
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  | 'clay'
  | 'pinch'
  | 'scrape'
  | 'terrace'
  | 'noise'
export type BrushDomain = 'heightfield' | 'mesh'
export type PaintMode = 'add' | 'subtract'
export type CsgOperation = 'subtract' | 'add'

export interface ModifierTransform {
  offset: Vec3Like
  yaw: number
  pitch?: number
  roll?: number
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
  /**
   * Position in the authored order, assigned by the stack.
   *
   * Order is part of the meaning of a stroke, not a detail: a brush records its
   * dabs against the surface as it stood when it was drawn, so replaying it
   * against a different surface is not the same edit. Ties used to fall back to
   * comparing ids, which are random UUIDs, so equal-priority strokes evaluated
   * in an arbitrary order and later passes could miss the surface entirely.
   */
  sequence?: number
}

export interface BrushStrokeModifier extends ModifierBase {
  type: 'brush-stroke'
  mode: BrushMode
  domain: BrushDomain
  radius: number
  strength: number
  falloff: number
  targetY?: number
  terraceStep?: number
  noiseScale?: number
  noiseSeed?: number
  /** Lets one stroke keep building while held instead of settling on a depth. */
  accumulate?: boolean
  sculptLayerId?: string
  points: BrushSample[]
}

export interface WeightPaintModifier extends ModifierBase {
  type: 'weight-paint'
  channel: TerrainPaintChannelId
  mode: PaintMode
  radius: number
  strength: number
  falloff: number
  points: BrushSample[]
}

export interface SculptLayerModifier extends ModifierBase {
  type: 'sculpt-layer'
  name: string
  opacity: number
}

export interface MaterialSettingsModifier extends ModifierBase {
  type: 'material-settings'
  settings: TerrainMaterialSettings
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
  /** Relative wall and cross-section roughness. Zero produces a clean sweep. */
  noise: number
  /** World-space wavelength of the tunnel's close surface breakup. */
  noiseScale: number
  /** Camera-drilled branches joined into this same subtractive CSG modifier. */
  carves?: CutterVolume[]
  backend: string
}

/** Serializable closed meshes combined with the terrain by exact live CSG. */
export interface BooleanVolumeModifier extends ModifierBase {
  type: 'boolean-volume'
  operation: CsgOperation
  volumes: CutterVolume[]
  backend: string
}

export type TerrainModifier =
  | BrushStrokeModifier
  | WeightPaintModifier
  | SculptLayerModifier
  | MaterialSettingsModifier
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
