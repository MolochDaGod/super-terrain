import { Eye, EyeOff, Layers3, Plus, Trash2 } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import {
  useEditorSnapshot,
  useModifierRevision,
} from '../../terrain/react/hooks'
import { RangeField } from './RangeField'

export function SculptLayersPanel({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  useModifierRevision(terrain)
  const snapshot = useEditorSnapshot(editor)
  const layers = terrain.getSculptLayers()
  const active =
    layers.find((layer) => layer.id === snapshot.activeSculptLayerId) ?? layers[0]

  return (
    <section className="border-b border-white/[0.07] px-3.5 pb-4">
      <header className="flex items-center justify-between pb-3 pt-4">
        <span className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/35">
          <Layers3 size={12} /> Sculpt layers
        </span>
        <button
          type="button"
          className="grid size-6 place-items-center rounded-md border border-white/[0.08] text-white/45 hover:bg-white/[0.06] hover:text-white"
          title="Add sculpt layer"
          onClick={() => {
            const id = terrain.addSculptLayer()
            editor.patch({ activeSculptLayerId: id, status: 'Sculpt layer added' })
          }}
        >
          <Plus size={12} />
        </button>
      </header>

      <div className="space-y-1">
        {[...layers].reverse().map((layer) => (
          <div
            key={layer.id}
            className={`flex items-center gap-1 rounded-md border px-1.5 py-1 ${
              active?.id === layer.id
                ? 'border-[#77e8be]/30 bg-[#77e8be]/[0.07]'
                : 'border-white/[0.06] bg-white/[0.018]'
            }`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 px-1 text-left text-[9px] text-white/68"
              onClick={() => editor.patch({ activeSculptLayerId: layer.id })}
            >
              <span className="block truncate">{layer.name}</span>
              <span className="font-mono text-[7px] text-white/25">
                {Math.round(layer.opacity * 100)}% · {layer.enabled ? 'live' : 'hidden'}
              </span>
            </button>
            <button
              type="button"
              className="grid size-6 place-items-center rounded text-white/30 hover:bg-white/[0.06] hover:text-white/70"
              onClick={() => terrain.updateSculptLayer(layer.id, { enabled: !layer.enabled })}
            >
              {layer.enabled ? <Eye size={11} /> : <EyeOff size={11} />}
            </button>
            <button
              type="button"
              disabled={layers.length <= 1}
              className="grid size-6 place-items-center rounded text-white/20 hover:bg-[#ff826f]/10 hover:text-[#ff826f] disabled:opacity-20"
              onClick={() => {
                if (!terrain.removeSculptLayer(layer.id)) return
                const next = terrain.getSculptLayers()[0]
                editor.patch({ activeSculptLayerId: next?.id })
              }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>

      {active && (
        <div className="mt-3 space-y-3">
          <label className="block">
            <span className="mb-1 block text-[8px] uppercase tracking-[0.12em] text-white/30">
              Layer name
            </span>
            <input
              key={`${active.id}:${active.name}`}
              defaultValue={active.name}
              className="w-full rounded-md border border-white/[0.08] bg-black/15 px-2 py-1.5 text-[9px] text-white/70 outline-none focus:border-[#77e8be]/35"
              onBlur={(event) =>
                terrain.updateSculptLayer(active.id, { name: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
          </label>
          <RangeField
            label="Layer opacity"
            value={active.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(opacity) => terrain.updateSculptLayer(active.id, { opacity })}
          />
        </div>
      )}
    </section>
  )
}
