import { Mountain } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { graniteMassingOfSeed } from '../../terrain/rocks/types'
import {
  useEditorSnapshot,
  useGraniteRockRevision,
} from '../../terrain/react/hooks'
import { CollapsibleSection } from './ui/Section'
import { ListRow } from './ui/ListRow'
import { EmptyHint } from './ui/EmptyHint'

/**
 * The granite rocks in the scene. A list, and nothing else: selecting a row is
 * the same act as clicking the rock in the viewport, and its recipe appears in
 * the parameters panel on the other side either way.
 */
export function RocksSection({
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
  useGraniteRockRevision(terrain)
  const snapshot = useEditorSnapshot(editor)
  const rocks = terrain.rocks.snapshot()

  return (
    <CollapsibleSection
      icon={Mountain}
      title="Rocks"
      badge={rocks.length}
      open={open}
      onToggle={onToggle}
    >
      {rocks.length === 0 ? (
        <EmptyHint>Add · Granite rock places one at the 3D cursor.</EmptyHint>
      ) : (
        <div className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
          {rocks.map((rock) => (
            <ListRow
              key={rock.id}
              title={rock.name}
              meta={`${graniteMassingOfSeed(rock.parameters.seed)} · seed ${rock.parameters.seed}`}
              selected={rock.id === snapshot.selectedRockId}
              visible={rock.visible}
              onSelect={() =>
                editor.select('rock', rock.id, `${rock.name} selected`)
              }
              onToggleVisible={() =>
                terrain.setGraniteRockVisible(rock.id, !rock.visible)
              }
              onDelete={() => {
                terrain.removeGraniteRock(rock.id)
                if (snapshot.selectedRockId === rock.id) {
                  editor.patch({ selectedRockId: undefined })
                }
              }}
            />
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}
