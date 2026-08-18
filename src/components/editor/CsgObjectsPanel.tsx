import { Box, Circle, FileUp, Pill } from 'lucide-react'
import type { ChangeEvent } from 'react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type {
  CsgPrimitive,
  EditorStore,
} from '../../terrain/editor/EditorStore'
import { importCsgGlb } from '../../terrain/import/importCsgGlb'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { RangeField } from './RangeField'

const PRIMITIVES: Array<{
  id: CsgPrimitive
  label: string
  icon: typeof Box
}> = [
  { id: 'box', label: 'Box', icon: Box },
  { id: 'sphere', label: 'Sphere', icon: Circle },
  { id: 'capsule', label: 'Capsule', icon: Pill },
]

export function CsgObjectsPanel({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
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
    <section className="border-b border-white/[0.07] px-3.5 pb-4">
      <header className="flex items-center gap-2 pb-3 pt-4 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/35">
        <Box size={12} /> Procedural CSG objects
      </header>
      <div className="grid grid-cols-3 gap-1">
        {PRIMITIVES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            data-active={snapshot.csgPrimitive === id}
            className="grid place-items-center gap-1 rounded-md border border-white/[0.07] px-1 py-2 text-[8px] transition"
            onClick={() => editor.patch({ csgPrimitive: id })}
          >
            <Icon size={12} /> {label}
          </button>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg border border-white/[0.07] bg-black/10 p-1">
        {(['subtract', 'add'] as const).map((operation) => (
          <button
            key={operation}
            type="button"
            data-active={snapshot.csgOperation === operation}
            className="rounded-md px-2 py-1.5 text-[9px] capitalize transition"
            onClick={() => editor.patch({ csgOperation: operation })}
          >
            {operation}
          </button>
        ))}
      </div>
      <div className="mt-3">
        <RangeField
          label="Object size"
          value={snapshot.csgSize}
          min={1}
          max={96}
          step={1}
          unit=" m"
          onChange={(csgSize) => editor.patch({ csgSize })}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          className="rounded-md border border-[#77e8be]/20 bg-[#77e8be]/[0.07] px-2 py-2 text-[9px] text-[#b7f6df] hover:bg-[#77e8be]/[0.12]"
          onClick={addPrimitive}
        >
          Add at cursor
        </button>
        <label className="flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-white/[0.09] px-2 py-2 text-[9px] text-white/55 hover:bg-white/[0.05]">
          <FileUp size={11} /> Import GLB
          <input type="file" accept=".glb,model/gltf-binary" hidden onChange={importMesh} />
        </label>
      </div>
      <p className="mt-2 text-[8px] leading-relaxed text-white/25">
        Click terrain to place. CSG stays live in the modifier stack after every move, rotation, or scale.
      </p>
    </section>
  )
}
