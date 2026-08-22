import { Lightbulb } from 'lucide-react'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { EmptyHint } from './ui/EmptyHint'
import { ListRow } from './ui/ListRow'
import { CollapsibleSection } from './ui/Section'

/**
 * The scene's lights, listed beside the other scene collections rather than
 * in a panel of their own floating over the viewport. Adding one is an Add
 * action on the object toolbar; selecting one here fills the panel above with
 * its parameters.
 */
export function LightsSection({
  editor,
  open,
  onToggle,
}: {
  editor: EditorStore
  open: boolean
  onToggle: () => void
}) {
  const snapshot = useEditorSnapshot(editor)

  return (
    <CollapsibleSection
      icon={Lightbulb}
      title="Lights"
      badge={snapshot.lights.length}
      open={open}
      onToggle={onToggle}
    >
      {snapshot.lights.length === 0 ? (
        <EmptyHint>Add · Point light places one at the terrain cursor.</EmptyHint>
      ) : (
        <div className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
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
    </CollapsibleSection>
  )
}

function formatIntensity(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString()
}
