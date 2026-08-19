import { Flashlight, Lightbulb, Plus } from 'lucide-react'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import type { EditorLightType } from '../../terrain/editor/lights'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { EmptyHint } from './ui/EmptyHint'
import { ListRow } from './ui/ListRow'

export function LightsPanel({ editor }: { editor: EditorStore }) {
  const snapshot = useEditorSnapshot(editor)

  return (
    <aside className="pointer-events-auto absolute left-[68px] top-[68px] z-20 hidden w-[224px] overflow-hidden rounded-xl border border-white/[0.09] bg-[#0b1312]/92 shadow-2xl shadow-black/30 backdrop-blur-xl md:block lg:left-[366px]">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
        <Lightbulb size={13} className="text-[#ffd2a1]" />
        <span className="panel-title flex-1">Lights</span>
        <span className="panel-meta font-mono">{snapshot.lights.length}</span>
      </div>

      <div className="space-y-2.5 p-2.5">
        <div className="grid grid-cols-2 gap-1.5">
          <AddLightButton type="point" editor={editor} />
          <AddLightButton type="spot" editor={editor} />
        </div>

        {snapshot.lights.length === 0 ? (
          <EmptyHint>Add a finite-range light at the terrain cursor.</EmptyHint>
        ) : (
          <div className="max-h-[42vh] space-y-1 overflow-y-auto pr-0.5">
            {snapshot.lights.map((light) => (
              <ListRow
                key={light.id}
                title={light.name}
                meta={`${light.type} · ${formatIntensity(light.intensity)} · ${Math.round(light.distance)} m`}
                lead={
                  <span
                    className="size-2.5 shrink-0 rounded-full border border-white/20"
                    style={{ backgroundColor: light.color }}
                  />
                }
                selected={snapshot.selectedLightId === light.id}
                visible={light.visible}
                onSelect={() => editor.selectLight(light.id)}
                onToggleVisible={() =>
                  editor.updateLight(light.id, { visible: !light.visible })
                }
                onDelete={() => editor.removeLight(light.id)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function AddLightButton({
  type,
  editor,
}: {
  type: EditorLightType
  editor: EditorStore
}) {
  const Icon = type === 'point' ? Lightbulb : Flashlight
  const label = type === 'point' ? 'Point' : 'Spot'
  return (
    <button
      type="button"
      className="panel-button"
      data-accent={type === 'point' ? 'coral' : 'mint'}
      title={`Add ${label.toLowerCase()} light at the terrain cursor`}
      onClick={() => editor.addLight(type)}
    >
      <span className="relative">
        <Icon size={12} />
        <Plus size={7} strokeWidth={3} className="absolute -right-1 -top-1" />
      </span>
      {label}
    </button>
  )
}

function formatIntensity(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString()
}
