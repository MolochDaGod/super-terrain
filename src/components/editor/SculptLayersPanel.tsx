import { Layers3 } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import {
  useEditorSnapshot,
  useModifierRevision,
} from '../../terrain/react/hooks'
import { RangeField } from './RangeField'
import { CollapsibleSection } from './ui/Section'
import { ListRow } from './ui/ListRow'

export function SculptLayersPanel({
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
  useModifierRevision(terrain)
  const snapshot = useEditorSnapshot(editor)
  const layers = terrain.getSculptLayers()
  const active =
    layers.find((layer) => layer.id === snapshot.activeSculptLayerId) ?? layers[0]

  return (
    <CollapsibleSection
      icon={Layers3}
      title="Layers"
      badge={layers.length}
      open={open}
      onToggle={onToggle}
    >
      <div className="space-y-1">
        {[...layers].reverse().map((layer) => (
          <ListRow
            key={layer.id}
            title={layer.name}
            meta={`${Math.round(layer.opacity * 100)}%`}
            selected={active?.id === layer.id}
            visible={layer.enabled}
            deleteDisabled={layers.length <= 1}
            onSelect={() => editor.patch({ activeSculptLayerId: layer.id })}
            onToggleVisible={() =>
              terrain.updateSculptLayer(layer.id, { enabled: !layer.enabled })
            }
            onDelete={() => {
              if (!terrain.removeSculptLayer(layer.id)) return
              const next = terrain.getSculptLayers()[0]
              editor.patch({ activeSculptLayerId: next?.id })
            }}
          />
        ))}
      </div>

      {active && (
        <div className="space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.018] p-2.5">
          <input
            key={`${active.id}:${active.name}`}
            aria-label="Layer name"
            defaultValue={active.name}
            className="text-input"
            onBlur={(event) =>
              terrain.updateSculptLayer(active.id, { name: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
          <RangeField
            label="Opacity"
            value={active.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(opacity) => terrain.updateSculptLayer(active.id, { opacity })}
          />
        </div>
      )}
    </CollapsibleSection>
  )
}
