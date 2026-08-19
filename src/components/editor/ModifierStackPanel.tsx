import { memo } from 'react'
import { Layers } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import {
  useEditorSnapshot,
  useModifierRevision,
} from '../../terrain/react/hooks'
import { modifierLabel, modifierMeta } from './modifierLabel'
import { CollapsibleSection } from './ui/Section'
import { ListRow } from './ui/ListRow'
import { EmptyHint } from './ui/EmptyHint'

interface ModifierStackPanelProps {
  terrain: WorldTerrain
  editor: EditorStore
  open: boolean
  onToggle: () => void
}

function ModifierStackPanelView({
  terrain,
  editor,
  open,
  onToggle,
}: ModifierStackPanelProps) {
  useModifierRevision(terrain)
  const editorSnapshot = useEditorSnapshot(editor)
  const modifiers = terrain.modifiers
    .snapshot()
    .filter(
      (modifier) =>
        modifier.type !== 'sculpt-layer' &&
        modifier.type !== 'material-settings',
    )
    .reverse()

  return (
    <CollapsibleSection
      icon={Layers}
      title="Modifiers"
      badge={modifiers.length}
      open={open}
      onToggle={onToggle}
    >
      {modifiers.length === 0 ? (
        <EmptyHint>A brush stroke or topology operation appears here.</EmptyHint>
      ) : (
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {modifiers.map((modifier, index) => (
            <ListRow
              key={modifier.id}
              title={modifierLabel(modifier)}
              meta={modifierMeta(modifier)}
              lead={
                <span className="font-mono text-[10px] text-white/22">
                  {(modifiers.length - index).toString().padStart(2, '0')}
                </span>
              }
              selected={modifier.id === editorSnapshot.selectedModifierId}
              visible={modifier.enabled}
              onSelect={() =>
                editor.patch({
                  selectedModifierId: modifier.id,
                  selectedRockId: undefined,
                  selectedLightId: undefined,
                  status: `${modifierLabel(modifier)} selected`,
                })
              }
              onToggleVisible={() => {
                terrain.setModifierEnabled(modifier.id, !modifier.enabled)
                editor.patch({
                  status: `${modifierLabel(modifier)} ${modifier.enabled ? 'disabled' : 'enabled'}`,
                })
              }}
              onDelete={() => {
                terrain.removeModifier(modifier.id)
                if (editorSnapshot.selectedModifierId === modifier.id) {
                  editor.patch({ selectedModifierId: undefined })
                }
              }}
            />
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}

// The inspector also subscribes to 10 Hz renderer telemetry. This subtree has
// its own modifier/editor subscriptions, so reconciling every row again for an
// unrelated FPS update only creates garbage and periodic main-thread stalls.
const MemoizedModifierStackPanel = memo(ModifierStackPanelView)

export function ModifierStackPanel(props: ModifierStackPanelProps) {
  return <MemoizedModifierStackPanel {...props} />
}
