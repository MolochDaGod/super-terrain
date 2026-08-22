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
import {
  createEditorLight,
  patchEditorLight,
  type EditorLight,
  type EditorLightPatch,
  type EditorLightType,
} from './lights'

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
  | 'dig'

export type TransformMode = 'translate' | 'rotate' | 'scale'
export type CsgPrimitive = 'box' | 'sphere' | 'capsule'

export type TerrainOverlay =
  | 'none'
  | 'sections'
  | 'lod'
  | 'density'
  | 'streaming'

export type CameraMode = 'orbit' | 'fly'
export type UiViewMode = 'editor' | 'clean'
export type DprMode = 'low' | 'medium' | 'full'

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
    case 'dig':
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
  tunnelNoise: number
  tunnelNoiseScale: number
  digRadius: number
  digSpeed: number
  digNoise: number
  digNoiseScale: number
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
  uiViewMode: UiViewMode
  dprMode: DprMode
  showHud: boolean
  showHelp: boolean
  cursorPosition: Vec3Like
  cursorNormal: Vec3Like
  cursorVisible: boolean
  dragging: boolean
  selectedSection?: SectionId
  selectedModifierId?: string
  selectedRockId?: string
  selectedLightId?: string
  lights: readonly EditorLight[]
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
  tunnelNoise: 1,
  tunnelNoiseScale: 2.6,
  digRadius: 7,
  digSpeed: 18,
  digNoise: 0.9,
  digNoiseScale: 2.6,
  csgPrimitive: 'box',
  csgOperation: 'subtract',
  csgSize: 16,
  rockParameters: { ...DEFAULT_GRANITE_ROCK_PARAMETERS },
  transformMode: 'translate',
  overlay: 'none',
  openSection: 'modifiers',
  renderMode: 'preview',
  cameraMode: 'orbit',
  uiViewMode: 'editor',
  dprMode: 'medium',
  showHud: true,
  showHelp: false,
  cursorPosition: { x: 0, y: 0, z: 0 },
  cursorNormal: { x: 0, y: 1, z: 0 },
  cursorVisible: false,
  dragging: false,
  lights: [],
  status: 'World ready',
}

let nextLightId = 1

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

  addLight(type: EditorLightType): string {
    const snapshot = this.getSnapshot()
    const position = snapshot.cursorVisible
      ? {
          x: snapshot.cursorPosition.x,
          y: snapshot.cursorPosition.y + 18,
          z: snapshot.cursorPosition.z,
        }
      : { x: 0, y: 80, z: 0 }
    const typeIndex =
      snapshot.lights.filter((light) => light.type === type).length + 1
    const id = `light-${nextLightId++}`
    const light = createEditorLight(type, id, typeIndex, position)
    this.patch({
      lights: [...snapshot.lights, light],
      selectedLightId: id,
      selectedModifierId: undefined,
      selectedRockId: undefined,
      tool: 'select',
      transformMode: 'translate',
      status: `${light.name} added at ${snapshot.cursorVisible ? 'terrain cursor' : 'world origin'}`,
    })
    return id
  }

  updateLight(id: string, values: EditorLightPatch): void {
    const snapshot = this.getSnapshot()
    this.patch({
      lights: snapshot.lights.map((light) =>
        light.id === id ? patchEditorLight(light, values) : light,
      ),
    })
  }

  selectLight(id: string): void {
    const light = this.getSnapshot().lights.find((entry) => entry.id === id)
    if (!light) return
    this.patch({
      selectedLightId: id,
      selectedModifierId: undefined,
      selectedRockId: undefined,
      tool: 'select',
      transformMode:
        light.type === 'spot' && this.getSnapshot().transformMode === 'rotate'
          ? 'rotate'
          : 'translate',
      status: `${light.name} selected`,
    })
  }

  removeLight(id: string): void {
    const snapshot = this.getSnapshot()
    const light = snapshot.lights.find((entry) => entry.id === id)
    if (!light) return
    this.patch({
      lights: snapshot.lights.filter((entry) => entry.id !== id),
      selectedLightId:
        snapshot.selectedLightId === id ? undefined : snapshot.selectedLightId,
      status: `${light.name} removed`,
    })
  }
}
