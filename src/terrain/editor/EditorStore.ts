import { ExternalStore } from '../core/ExternalStore'
import type { SectionId, Vec3Like } from '../core/types'
import type {
  BrushDomain,
  CsgOperation,
  PaintMode,
} from '../modifiers/types'
import type { TerrainPaintChannelId } from '../rendering/materialSettings'
import type { TerrainRenderMode } from '../rendering/renderModes'
import {
  DEFAULT_GRANITE_ROCK_PARAMETERS,
  type GraniteRockParameters,
} from '../rocks/types'

export type EditorTool =
  | 'select'
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  | 'clay'
  | 'pinch'
  | 'scrape'
  | 'terrace'
  | 'noise'
  | 'paint'
  | 'remesh'
  | 'tunnel'

export type TransformMode = 'translate' | 'rotate' | 'scale'
export type CsgPrimitive = 'box' | 'sphere' | 'capsule'

export type TerrainOverlay =
  | 'none'
  | 'sections'
  | 'lod'
  | 'density'
  | 'streaming'

export type CameraMode = 'orbit' | 'fly'

/** Scene sections in the inspector. One is open at a time. */
export type InspectorSection =
  | 'layers'
  | 'materials'
  | 'rocks'
  | 'csg'
  | 'modifiers'
  | 'display'

/**
 * The section a tool needs. Switching tools opens it, so the panel below the
 * tool parameters is always the one the current tool works with.
 */
export function inspectorSectionForTool(tool: EditorTool): InspectorSection {
  switch (tool) {
    case 'paint':
      return 'materials'
    case 'select':
    case 'tunnel':
    case 'remesh':
      return 'modifiers'
    default:
      return 'layers'
  }
}

export interface EditorSnapshot {
  tool: EditorTool
  brushDomain: BrushDomain
  brushRadius: number
  brushStrength: number
  brushFalloff: number
  terraceStep: number
  noiseScale: number
  activeSculptLayerId?: string
  activePaintChannel: TerrainPaintChannelId
  paintMode: PaintMode
  targetEdgeLength: number
  tunnelRadius: number
  tunnelDepth: number
  csgPrimitive: CsgPrimitive
  csgOperation: CsgOperation
  csgSize: number
  rockParameters: GraniteRockParameters
  transformMode: TransformMode
  overlay: TerrainOverlay
  /** Undefined when every scene section is collapsed. */
  openSection?: InspectorSection
  renderMode: TerrainRenderMode
  cameraMode: CameraMode
  showHud: boolean
  showHelp: boolean
  cursorPosition: Vec3Like
  cursorNormal: Vec3Like
  cursorVisible: boolean
  dragging: boolean
  selectedSection?: SectionId
  selectedModifierId?: string
  selectedRockId?: string
  status: string
}

const INITIAL_EDITOR_STATE: EditorSnapshot = {
  tool: 'select',
  brushDomain: 'mesh',
  brushRadius: 22,
  brushStrength: 0.38,
  brushFalloff: 0.55,
  terraceStep: 4,
  noiseScale: 3,
  activePaintChannel: 'channel0',
  paintMode: 'add',
  targetEdgeLength: 2.5,
  tunnelRadius: 8,
  tunnelDepth: 14,
  csgPrimitive: 'box',
  csgOperation: 'subtract',
  csgSize: 16,
  rockParameters: { ...DEFAULT_GRANITE_ROCK_PARAMETERS },
  transformMode: 'translate',
  overlay: 'none',
  openSection: 'modifiers',
  renderMode: 'preview',
  cameraMode: 'orbit',
  showHud: true,
  showHelp: false,
  cursorPosition: { x: 0, y: 0, z: 0 },
  cursorNormal: { x: 0, y: 1, z: 0 },
  cursorVisible: false,
  dragging: false,
  status: 'World ready',
}

export class EditorStore extends ExternalStore<EditorSnapshot> {
  constructor() {
    super(INITIAL_EDITOR_STATE)
  }

  patch(values: Partial<EditorSnapshot>): void {
    this.update((current) => ({ ...current, ...values }))
  }

  setCursor(
    position: Vec3Like,
    normal: Vec3Like,
    selectedSection?: SectionId,
  ): void {
    this.patch({
      cursorPosition: { ...position },
      cursorNormal: { ...normal },
      cursorVisible: true,
      selectedSection,
    })
  }

  hideCursor(): void {
    this.patch({ cursorVisible: false })
  }
}
