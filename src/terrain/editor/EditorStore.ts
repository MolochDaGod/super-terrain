import { ExternalStore } from '../core/ExternalStore'
import type { SectionId, Vec3Like } from '../core/types'
import type { BrushDomain } from '../modifiers/types'
import type { TerrainRenderMode } from '../rendering/renderModes'

export type EditorTool =
  | 'select'
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  | 'remesh'
  | 'tunnel'

export type TerrainOverlay =
  | 'none'
  | 'sections'
  | 'lod'
  | 'density'
  | 'streaming'

export type CameraMode = 'orbit' | 'fly'

export interface EditorSnapshot {
  tool: EditorTool
  brushDomain: BrushDomain
  brushRadius: number
  brushStrength: number
  brushFalloff: number
  targetEdgeLength: number
  tunnelRadius: number
  tunnelDepth: number
  overlay: TerrainOverlay
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
  status: string
}

const INITIAL_EDITOR_STATE: EditorSnapshot = {
  tool: 'select',
  brushDomain: 'mesh',
  brushRadius: 22,
  brushStrength: 0.38,
  brushFalloff: 0.55,
  targetEdgeLength: 2.5,
  tunnelRadius: 8,
  tunnelDepth: 14,
  overlay: 'none',
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
    this.patch({ cursorVisible: false, dragging: false })
  }
}
