import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type {
  EditorSnapshot,
  EditorStore,
} from '../../terrain/editor/EditorStore'
import type { EditorLightType } from '../../terrain/editor/lights'
import type { Vec3Like } from '../../terrain/core/types'
import type { CsgOperation } from '../../terrain/modifiers/types'
import { importCsgGlb } from '../../terrain/import/importCsgGlb'
import { randomGraniteRockParameters } from '../../terrain/rocks/types'
import { modifierLabel } from './modifierLabel'

/**
 * Viewport actions live here rather than inside a panel because the menu bar,
 * the object toolbar and the keyboard shortcuts all have to invoke exactly the
 * same behaviour. A panel that owns an action is an action the other two
 * surfaces have to re-implement.
 */

export type SelectionKind = 'rock' | 'modifier' | 'light'

export interface EditorSelection {
  kind: SelectionKind
  id: string
  name: string
  /** Rocks and lights can be hidden; modifiers are enabled/disabled. */
  visible: boolean
  /** World point the camera frames, when the selection has one. */
  position?: Vec3Like
  canDuplicate: boolean
}

/** The one selected thing, whichever store it lives in. */
export function currentSelection(
  terrain: WorldTerrain,
  snapshot: EditorSnapshot,
): EditorSelection | undefined {
  if (snapshot.selectedRockId) {
    const rock = terrain.rocks.get(snapshot.selectedRockId)
    if (rock) {
      return {
        kind: 'rock',
        id: rock.id,
        name: rock.name,
        visible: rock.visible,
        position: rock.transform.position,
        canDuplicate: true,
      }
    }
  }
  if (snapshot.selectedLightId) {
    const light = snapshot.lights.find(
      (entry) => entry.id === snapshot.selectedLightId,
    )
    if (light) {
      return {
        kind: 'light',
        id: light.id,
        name: light.name,
        visible: light.visible,
        position: light.position,
        canDuplicate: true,
      }
    }
  }
  if (snapshot.selectedModifierId) {
    const modifier = terrain.modifiers.get(snapshot.selectedModifierId)
    if (modifier) {
      return {
        kind: 'modifier',
        id: modifier.id,
        name: modifierLabel(modifier),
        visible: modifier.enabled,
        // A modifier's transform is an offset from where it was authored, so
        // its bounds centre is the only honest world point to frame.
        position: {
          x: (modifier.bounds.min.x + modifier.bounds.max.x) / 2,
          y: (modifier.bounds.min.y + modifier.bounds.max.y) / 2,
          z: (modifier.bounds.min.z + modifier.bounds.max.z) / 2,
        },
        canDuplicate: false,
      }
    }
  }
  return undefined
}

export function clearSelection(editor: EditorStore): void {
  editor.patch({
    selectedRockId: undefined,
    selectedModifierId: undefined,
    selectedLightId: undefined,
    status: 'Selection cleared',
  })
}

export function deleteSelection(
  terrain: WorldTerrain,
  editor: EditorStore,
): void {
  const selection = currentSelection(terrain, editor.getSnapshot())
  if (!selection) return
  if (selection.kind === 'light') {
    editor.removeLight(selection.id)
    return
  }
  if (selection.kind === 'rock') {
    terrain.removeGraniteRock(selection.id)
    editor.patch({ selectedRockId: undefined, status: `${selection.name} deleted` })
    return
  }
  terrain.removeModifier(selection.id)
  editor.patch({
    selectedModifierId: undefined,
    status: `${selection.name} deleted · affected sections queued`,
  })
}

export function duplicateSelection(
  terrain: WorldTerrain,
  editor: EditorStore,
): void {
  const snapshot = editor.getSnapshot()
  const selection = currentSelection(terrain, snapshot)
  if (!selection?.canDuplicate) return
  if (selection.kind === 'light') {
    editor.duplicateLight(selection.id)
    return
  }
  const rock = terrain.rocks.get(selection.id)
  if (!rock) return
  const id = terrain.addGraniteRock(rock.parameters, placementPoint(terrain, snapshot))
  editor.patch({
    selectedRockId: id,
    selectedModifierId: undefined,
    selectedLightId: undefined,
    tool: 'select',
    transformMode: 'translate',
    status: `${rock.name} duplicated at cursor`,
  })
}

export function toggleSelectionVisible(
  terrain: WorldTerrain,
  editor: EditorStore,
): void {
  const selection = currentSelection(terrain, editor.getSnapshot())
  if (!selection) return
  if (selection.kind === 'light') {
    editor.updateLight(selection.id, { visible: !selection.visible })
    editor.patch({
      status: `${selection.name} ${selection.visible ? 'hidden' : 'shown'}`,
    })
    return
  }
  if (selection.kind === 'rock') {
    terrain.setGraniteRockVisible(selection.id, !selection.visible)
    editor.patch({
      status: `${selection.name} ${selection.visible ? 'hidden' : 'shown'}`,
    })
    return
  }
  terrain.setModifierEnabled(selection.id, !selection.visible)
  editor.patch({
    status: `${selection.name} ${selection.visible ? 'disabled' : 'enabled'}`,
  })
}

export function focusSelection(
  terrain: WorldTerrain,
  editor: EditorStore,
): void {
  const selection = currentSelection(terrain, editor.getSnapshot())
  const target = selection?.position
  if (!target) return
  editor.requestFocus(target)
  editor.patch({ status: `Framed ${selection.name}` })
}

/** Where "add at cursor" puts things: the 3D cursor, the hovered surface, or the ground under it. */
export function placementPoint(
  terrain: WorldTerrain,
  snapshot: EditorSnapshot,
): Vec3Like {
  // The placed 3D cursor wins: it is the only point that is still meaningful
  // once the pointer has left the viewport to reach the menu that is asking.
  if (snapshot.worldCursor) return snapshot.worldCursor
  if (snapshot.cursorVisible) return snapshot.cursorPosition
  return {
    x: snapshot.cursorPosition.x,
    y: terrain.sampleHeight(snapshot.cursorPosition.x, snapshot.cursorPosition.z),
    z: snapshot.cursorPosition.z,
  }
}

export function addLight(editor: EditorStore, type: EditorLightType): void {
  editor.addLight(type)
  editor.patch({ openSection: 'lights' })
}

export function addCsgVolume(
  terrain: WorldTerrain,
  editor: EditorStore,
  operation?: CsgOperation,
): void {
  const snapshot = editor.getSnapshot()
  const csgOperation = operation ?? snapshot.csgOperation
  const id = terrain.addCsgPrimitive(
    snapshot.csgPrimitive,
    csgOperation,
    placementPoint(terrain, snapshot),
    snapshot.csgSize,
  )
  editor.patch({
    csgOperation,
    selectedModifierId: id,
    selectedRockId: undefined,
    selectedLightId: undefined,
    tool: 'select',
    openSection: 'csg',
    status: `Editable CSG ${csgOperation} object added`,
  })
}

export async function importCsgMesh(
  terrain: WorldTerrain,
  editor: EditorStore,
  file: File,
): Promise<void> {
  const snapshot = editor.getSnapshot()
  editor.patch({ status: `Importing ${file.name}…` })
  try {
    const mesh = await importCsgGlb(file)
    const id = terrain.addCsgMesh(
      mesh.positions,
      mesh.indices,
      snapshot.csgOperation,
      placementPoint(terrain, snapshot),
    )
    editor.patch({
      selectedModifierId: id,
      selectedRockId: undefined,
      selectedLightId: undefined,
      tool: 'select',
      openSection: 'csg',
      status: `${file.name} added as editable CSG ${snapshot.csgOperation}`,
    })
  } catch (error) {
    editor.patch({
      status: error instanceof Error ? error.message : 'GLB import failed',
    })
  }
}

/** Opens the OS file picker without the UI having to host a hidden input. */
export function pickCsgMesh(terrain: WorldTerrain, editor: EditorStore): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.glb,model/gltf-binary'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) void importCsgMesh(terrain, editor, file)
  })
  input.click()
}

export function addRock(
  terrain: WorldTerrain,
  editor: EditorStore,
  options: { randomize?: boolean } = {},
): void {
  const snapshot = editor.getSnapshot()
  const parameters = options.randomize
    ? randomGraniteRockParameters(randomSeed())
    : snapshot.rockParameters
  const id = terrain.addGraniteRock(parameters, placementPoint(terrain, snapshot))
  editor.patch({
    rockParameters: { ...parameters },
    selectedRockId: id,
    selectedModifierId: undefined,
    selectedLightId: undefined,
    tool: 'select',
    transformMode: 'translate',
    openSection: 'rocks',
    status: options.randomize
      ? 'Random granite rock placed · translate gizmo active'
      : 'Granite rock placed · translate gizmo active',
  })
}

export function addSculptLayer(
  terrain: WorldTerrain,
  editor: EditorStore,
): void {
  const id = terrain.addSculptLayer()
  editor.patch({
    activeSculptLayerId: id,
    openSection: 'layers',
    status: 'Sculpt layer added',
  })
}

/** Snapshot the selected rock's triangles into the modifier stack. */
export async function convertRockToCsg(
  terrain: WorldTerrain,
  editor: EditorStore,
  operation: CsgOperation,
): Promise<void> {
  const rockId = editor.getSnapshot().selectedRockId
  const rock = rockId ? terrain.rocks.get(rockId) : undefined
  if (!rock) return
  editor.patch({
    status: `Extracting ${rock.name} topology at ${rock.parameters.topologyDetail}³…`,
  })
  try {
    const modifierId = await terrain.applyGraniteRockAsCsg(rock.id, operation)
    editor.patch({
      selectedRockId: undefined,
      selectedModifierId: modifierId,
      selectedLightId: undefined,
      tool: 'select',
      status: `${rock.name} hidden · topology snapshotted as CSG ${operation}`,
    })
  } catch (error) {
    editor.patch({
      status: error instanceof Error ? error.message : 'CSG snapshot failed',
    })
  }
}

export async function saveWorld(
  terrain: WorldTerrain,
  editor: EditorStore,
): Promise<void> {
  editor.patch({ status: 'Saving changed terrain sections…' })
  await terrain.save()
  editor.patch({ status: 'Terrain edits saved locally' })
}

export async function resetWorld(
  terrain: WorldTerrain,
  editor: EditorStore,
): Promise<void> {
  if (!window.confirm('Reset all local terrain edits to the demo world?')) return
  await terrain.resetEdits()
  editor.patch({
    activeSculptLayerId: terrain.getSculptLayers()[0]?.id,
    selectedModifierId: undefined,
    selectedRockId: undefined,
    selectedLightId: undefined,
    status: 'Terrain reset; sections rebuilding asynchronously',
  })
}

export function adjustBrushRadius(editor: EditorStore, delta: number): void {
  const snapshot = editor.getSnapshot()
  if (snapshot.tool === 'water') {
    editor.patch({ waterRadius: clamp(snapshot.waterRadius + delta * 2, 8, 260) })
    return
  }
  if (snapshot.tool === 'tunnel') {
    editor.patch({
      tunnelRadius: clamp(snapshot.tunnelRadius + delta, 2, 128),
    })
    return
  }
  if (snapshot.tool === 'dig') {
    editor.patch({ digRadius: clamp(snapshot.digRadius + delta, 1, 64) })
    return
  }
  editor.patch({ brushRadius: clamp(snapshot.brushRadius + delta, 4, 72) })
}

/** The radius the active tool actually uses, for the status bar and the HUD. */
export function activeRadius(snapshot: EditorSnapshot): number {
  if (snapshot.tool === 'tunnel') return snapshot.tunnelRadius
  if (snapshot.tool === 'dig') return snapshot.digRadius
  if (snapshot.tool === 'water') return snapshot.waterRadius
  return snapshot.brushRadius
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Deterministic-recipe seed source shared by "random rock" and the rock panel dice. */
export function randomSeed(): number {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]!
    return Math.max(1, value & 0x7fff_ffff)
  }
  return Math.max(1, Date.now() & 0x7fff_ffff)
}
