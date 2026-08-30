import { ExternalStore } from '../core/ExternalStore'
import type { SectionId, Vec3Like } from '../core/types'
import type {
  BrushDomain,
  CsgOperation,
  PaintMode,
} from '../modifiers/types'
import type { TerrainPaintChannelId } from '../rendering/materialSettings'
import type { TerrainEnvironmentLook } from '../rendering/environment/createTerrainEnvironment'
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
  | 'camera'
  | 'select'
  | 'cursor'
  | 'water'
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
  | 'forest'
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
export type WaterPaintMode = 'add' | 'remove'
export type UiViewMode = 'editor' | 'clean'
export type DprMode = 'low' | 'medium' | 'full'

/** Scene sections in the inspector. One is open at a time. */
export type InspectorSection =
  | 'layers'
  | 'materials'
  | 'rocks'
  | 'csg'
  | 'lights'
  | 'modifiers'
  | 'forests'

/**
 * The section a tool needs. Switching tools opens it, so the panel below the
 * tool parameters is always the one the current tool works with.
 */
export function inspectorSectionForTool(tool: EditorTool): InspectorSection {
  switch (tool) {
    case 'paint':
      return 'materials'
    case 'forest':
      return 'forests'
    case 'camera':
    case 'cursor':
    case 'water':
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
  /** Whether one stroke keeps building while held, or settles on a depth. */
  brushAccumulate: boolean
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
  waterMode: WaterPaintMode
  waterRadius: number
  waterStrength: number
  csgPrimitive: CsgPrimitive
  csgOperation: CsgOperation
  csgSize: number
  rockParameters: GraniteRockParameters
  transformMode: TransformMode
  overlay: TerrainOverlay
  /** Undefined when every scene section is collapsed. */
  openSection?: InspectorSection
  renderMode: TerrainRenderMode
  /**
   * Which light and sky rig the world is lit by.
   *
   * Switchable because the change is a matter of taste and the two are worth
   * putting side by side: `wooded-landscape` is the physical sky model with
   * nothing in front of it, `terrain` is the older rig with the authored alpine
   * cloud photograph behind the ridges.
   */
  environmentLook: TerrainEnvironmentLook
  /**
   * Sun shadows, cascades and all.
   *
   * Three 2048² depth passes a frame are the single largest fixed cost in the
   * full-quality rig, so being able to take them out is what makes it possible
   * to tell a lighting problem apart from a shadow one — and to keep authoring
   * responsive on a machine that cannot afford them.
   */
  shadows: boolean
  cameraMode: CameraMode
  uiViewMode: UiViewMode
  dprMode: DprMode
  showHud: boolean
  showHelp: boolean
  /** The first-run introduction. Reopenable from the Help menu. */
  showWelcome: boolean
  /** The new-world sheet. */
  showNewWorld: boolean
  cursorPosition: Vec3Like
  cursorNormal: Vec3Like
  cursorVisible: boolean
  /**
   * The placed 3D cursor, in world space.
   *
   * "Add at cursor" needs a point that survives the pointer leaving the
   * viewport to reach a menu, which the hovered surface point cannot: by the
   * time a menu item is clicked the pointer is over the menu. Undefined until
   * the user places one, in which case placement falls back to the last hovered
   * surface point.
   */
  worldCursor?: Vec3Like
  dragging: boolean
  /**
   * Set by "frame selection". The camera consumes it once and the nonce is
   * what makes framing the same object twice in a row still move the camera.
   */
  focusRequest?: { position: Vec3Like; nonce: number }
  selectedSection?: SectionId
  selectedModifierId?: string
  selectedRockId?: string
  selectedLightId?: string
  lights: readonly EditorLight[]
  status: string
}

/** How often the status-bar cursor readout is allowed to re-render. */
const CURSOR_READOUT_INTERVAL_MS = 100

const INITIAL_EDITOR_STATE: EditorSnapshot = {
  tool: 'camera',
  brushDomain: 'mesh',
  brushAccumulate: false,
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
  waterMode: 'add',
  waterRadius: 45,
  waterStrength: 0.5,
  csgPrimitive: 'box',
  csgOperation: 'subtract',
  csgSize: 16,
  rockParameters: { ...DEFAULT_GRANITE_ROCK_PARAMETERS },
  transformMode: 'translate',
  overlay: 'none',
  openSection: 'modifiers',
  renderMode: 'full',
  environmentLook: 'wooded-landscape',
  shadows: true,
  cameraMode: 'orbit',
  uiViewMode: 'editor',
  dprMode: 'medium',
  // Frame telemetry is diagnostic, not part of authoring. It is one keystroke
  // and one menu-bar button away for anyone who wants it.
  showHud: false,
  showHelp: false,
  showWelcome: false,
  showNewWorld: false,
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

  private cursorNotifyHandle?: ReturnType<typeof setTimeout>

  patch(values: Partial<EditorSnapshot>): void {
    // Any real patch wakes subscribers, which is also the cursor readout's
    // pending update delivered early.
    this.cancelCursorNotify()
    this.update((current) => ({ ...current, ...values }))
  }

  /**
   * Where the pointer is on the terrain.
   *
   * Written on every hover frame, and read back two very different ways. The
   * brush ring and the editor verbs pull it straight off `getSnapshot` when
   * they need it, so the snapshot is replaced immediately and they always see
   * the live position. React only ever *displays* it -- a coordinate readout
   * and a section label in the status bar -- so subscribers are woken on a
   * timer instead.
   *
   * Waking them per move meant a full re-render of the editor on every pointer
   * event, since the root reads this same snapshot: measured at roughly 30 ms a
   * frame, which was the whole of what remained of the hover cost once the ray
   * itself was accelerated. Ten updates a second is past what anyone can read
   * off a moving number.
   */
  setCursor(
    position: Vec3Like,
    normal: Vec3Like,
    selectedSection?: SectionId,
  ): void {
    this.setWithoutNotifying({
      ...this.getSnapshot(),
      cursorPosition: { ...position },
      cursorNormal: { ...normal },
      cursorVisible: true,
      selectedSection,
    })
    this.scheduleCursorNotify()
  }

  hideCursor(): void {
    // An edge, not a stream: the ring has to go out at once.
    this.cancelCursorNotify()
    this.patch({ cursorVisible: false })
  }

  private scheduleCursorNotify(): void {
    if (this.cursorNotifyHandle !== undefined) return
    this.cursorNotifyHandle = setTimeout(() => {
      this.cursorNotifyHandle = undefined
      this.notifyListeners()
    }, CURSOR_READOUT_INTERVAL_MS)
  }

  private cancelCursorNotify(): void {
    if (this.cursorNotifyHandle === undefined) return
    clearTimeout(this.cursorNotifyHandle)
    this.cursorNotifyHandle = undefined
  }

  /** Ask the orbit camera to centre on a world point. */
  requestFocus(position: Vec3Like): void {
    const previous = this.getSnapshot().focusRequest
    this.patch({
      focusRequest: { position: { ...position }, nonce: (previous?.nonce ?? 0) + 1 },
    })
  }

  /** Select one object, dropping whatever was selected before. */
  select(kind: 'rock' | 'modifier' | 'light', id: string, status: string): void {
    this.patch({
      selectedRockId: kind === 'rock' ? id : undefined,
      selectedModifierId: kind === 'modifier' ? id : undefined,
      selectedLightId: kind === 'light' ? id : undefined,
      status,
    })
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

  /** Copy a light and select the copy, offset so it is not hidden inside the original. */
  duplicateLight(id: string): string | undefined {
    const snapshot = this.getSnapshot()
    const source = snapshot.lights.find((entry) => entry.id === id)
    if (!source) return undefined
    const typeIndex =
      snapshot.lights.filter((light) => light.type === source.type).length + 1
    const copyId = `light-${nextLightId++}`
    const copy: EditorLight = {
      ...source,
      id: copyId,
      name: `${source.type === 'point' ? 'Point' : 'Spot'} Light ${typeIndex}`,
      position: { ...source.position, x: source.position.x + 12 },
    }
    this.patch({
      lights: [...snapshot.lights, copy],
      selectedLightId: copyId,
      status: `${source.name} duplicated`,
    })
    return copyId
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
