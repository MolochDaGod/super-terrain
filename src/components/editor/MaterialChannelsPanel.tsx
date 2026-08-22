import { Paintbrush } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import {
  useEditorSnapshot,
  useModifierRevision,
} from '../../terrain/react/hooks'
import { RangeField } from './RangeField'
import { Section } from './ui/Section'

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

export function MaterialChannelsPanel({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  useModifierRevision(terrain)
  const snapshot = useEditorSnapshot(editor)
  const settings = terrain.getMaterialSettings()
  const active =
    settings.channels.find(
      (channel) => channel.id === snapshot.activePaintChannel,
    ) ?? settings.channels[0]

  return (
    <Section
      icon={Paintbrush}
      title="Materials"
      badge={active.name}
    >
      <div className="grid grid-cols-2 gap-1.5">
        {settings.channels.map((channel) => (
          <button
            key={channel.id}
            type="button"
            data-active={channel.id === active.id}
            className="flex min-w-0 items-center gap-2 rounded-md border border-white/[0.07] px-2 py-2 text-left text-[11px] text-white/62 transition hover:bg-white/[0.04]"
            onClick={() => editor.patch({ activePaintChannel: channel.id })}
          >
            <span
              className="size-3 shrink-0 rounded-sm border border-white/20"
              style={{ backgroundColor: hex(channel.color) }}
            />
            <span className="truncate">{channel.name}</span>
          </button>
        ))}
      </div>

      <div className="space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.018] p-2.5">
        <div className="flex gap-2">
          <input
            aria-label={`${active.name} colour`}
            title="Channel colour"
            type="color"
            value={hex(active.color)}
            className="h-7 w-9 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
            onChange={(event) =>
              terrain.updateMaterialChannel(active.id, {
                color: Number.parseInt(event.target.value.slice(1), 16),
              })
            }
          />
          <input
            key={`${active.id}:${active.name}`}
            aria-label="Channel name"
            defaultValue={active.name}
            className="text-input"
            onBlur={(event) =>
              terrain.updateMaterialChannel(active.id, { name: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
        </div>
        <RangeField
          label="Roughness"
          value={active.roughness}
          min={0.05}
          max={1}
          step={0.01}
          onChange={(roughness) =>
            terrain.updateMaterialChannel(active.id, { roughness })
          }
        />
      </div>
    </Section>
  )
}
