import { ExternalStore } from '../core/ExternalStore'
import type { SectionId, Vec3Like } from '../core/types'

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

export interface EditorSnapshot {
  tool: EditorTool
  brushRadius: number
  brushStrength: number
  brushFalloff: number
  targetEdgeLength: number
  overlay: TerrainOverlay
  showHud: boolean
  showHelp: boolean
  cursorPosition: Vec3Like
  cursorVisible: boolean
  dragging: boolean
  selectedSection?: SectionId
  status: string
}

const INITIAL_EDITOR_STATE: EditorSnapshot = {
  tool: 'select',
  brushRadius: 22,
  brushStrength: 0.38,
  brushFalloff: 0.55,
  targetEdgeLength: 2.5,
  overlay: 'sections',
  showHud: true,
  showHelp: false,
  cursorPosition: { x: 0, y: 0, z: 0 },
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

  setCursor(position: Vec3Like, selectedSection?: SectionId): void {
    this.patch({
      cursorPosition: { ...position },
      cursorVisible: true,
      selectedSection,
    })
  }

  hideCursor(): void {
    this.patch({ cursorVisible: false, dragging: false })
  }
}
