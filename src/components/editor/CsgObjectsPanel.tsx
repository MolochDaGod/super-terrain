import { Box, Circle, FileUp, Pill } from 'lucide-react'
import type { ChangeEvent } from 'react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type {
  CsgPrimitive,
  EditorStore,
} from '../../terrain/editor/EditorStore'
import type { CsgOperation } from '../../terrain/modifiers/types'
import { importCsgGlb } from '../../terrain/import/importCsgGlb'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { RangeField } from './RangeField'
import { CollapsibleSection } from './ui/Section'
import { Segmented, type SegmentedOption } from './ui/Segmented'

const PRIMITIVES: SegmentedOption<CsgPrimitive>[] = [
  { value: 'box', label: 'Box', icon: Box },
  { value: 'sphere', label: 'Sphere', icon: Circle },
  { value: 'capsule', label: 'Capsule', icon: Pill },
]

const OPERATIONS: SegmentedOption<CsgOperation>[] = [
  { value: 'subtract', label: 'Subtract', hint: 'Cut the volume out of the terrain' },
  { value: 'add', label: 'Add', hint: 'Union the volume into the terrain' },
]

export function CsgObjectsPanel({
  terrain,
  editor,
  open,
  onToggle,
}: {
  terrain: WorldTerrain
  editor: EditorStore
  open: boolean
  onToggle: () => void
}) {
  const snapshot = useEditorSnapshot(editor)

  const addPrimitive = () => {
    const id = terrain.addCsgPrimitive(
      snapshot.csgPrimitive,
      snapshot.csgOperation,
      snapshot.cursorPosition,
      snapshot.csgSize,
    )
    editor.patch({
      selectedModifierId: id,
      selectedRockId: undefined,
      tool: 'select',
      status: `Editable CSG ${snapshot.csgOperation} object added`,
    })
  }

  const importMesh = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    editor.patch({ status: `Importing ${file.name}…` })
    try {
      const mesh = await importCsgGlb(file)
      const id = terrain.addCsgMesh(
        mesh.positions,
        mesh.indices,
        snapshot.csgOperation,
        snapshot.cursorPosition,
      )
      editor.patch({
        selectedModifierId: id,
        selectedRockId: undefined,
        tool: 'select',
        status: `${file.name} added as editable CSG ${snapshot.csgOperation}`,
      })
    } catch (error) {
      editor.patch({
        status: error instanceof Error ? error.message : 'GLB import failed',
      })
    }
  }

  return (
    <CollapsibleSection icon={Box} title="CSG" open={open} onToggle={onToggle}>
      <Segmented
        ariaLabel="CSG primitive"
        options={PRIMITIVES}
        value={snapshot.csgPrimitive}
        onChange={(csgPrimitive) => editor.patch({ csgPrimitive })}
      />
      <Segmented
        ariaLabel="CSG operation"
        options={OPERATIONS}
        value={snapshot.csgOperation}
        onChange={(csgOperation) => editor.patch({ csgOperation })}
      />
      <RangeField
        label="Size"
        value={snapshot.csgSize}
        min={1}
        max={96}
        step={1}
        unit=" m"
        onChange={(csgSize) => editor.patch({ csgSize })}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          className="panel-button"
          data-accent="mint"
          title="Place the volume at the terrain cursor"
          onClick={addPrimitive}
        >
          Add at cursor
        </button>
        <label
          className="panel-button cursor-pointer"
          title="Import a GLB mesh as an editable CSG volume"
        >
          <FileUp size={12} /> Import GLB
          <input type="file" accept=".glb,model/gltf-binary" hidden onChange={importMesh} />
        </label>
      </div>
    </CollapsibleSection>
  )
}
