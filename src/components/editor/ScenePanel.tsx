import { Boxes } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type {
  EditorStore,
  InspectorSection,
} from '../../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import type { ForestFieldStore } from '../../forest/ForestFieldStore'
import { ForestFieldsSection } from '../../forest/react/ForestFieldPanels'
import { LightsSection } from './LightsSection'
import { ModifierStackPanel } from './ModifierStackPanel'
import { RocksSection } from './RocksSection'
import { SculptLayersPanel } from './SculptLayersPanel'

/**
 * What is in the world.
 *
 * Every collection the editor knows about is here, in one column, instead of
 * being scattered through the panel that also holds parameters. That is the
 * whole point of an outliner: the answer to "what is in this scene, and which
 * of it am I looking at" should not require opening the panel that answers
 * "what is this one thing's radius".
 */
export function ScenePanel({
  terrain,
  editor,
  forest,
}: {
  terrain: WorldTerrain
  editor: EditorStore
  forest: ForestFieldStore
}) {
  const snapshot = useEditorSnapshot(editor)
  const sectionProps = (section: InspectorSection) => ({
    open: snapshot.openSection === section,
    onToggle: () =>
      editor.patch({
        openSection: snapshot.openSection === section ? undefined : section,
      }),
  })

  return (
    <aside
      aria-label="Scene"
      className="pointer-events-auto absolute bottom-7 left-3 top-[46px] z-20 hidden w-[236px] overflow-y-auto rounded-lg border border-white/[0.09] bg-[#0b1312]/92 shadow-2xl shadow-black/30 backdrop-blur-xl lg:block"
    >
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
        <Boxes size={12} strokeWidth={1.7} className="shrink-0 text-white/45" />
        <span className="panel-title min-w-0 flex-1 truncate">Scene</span>
      </div>
      <ForestFieldsSection forest={forest} {...sectionProps('forests')} />
      <LightsSection editor={editor} {...sectionProps('lights')} />
      <RocksSection terrain={terrain} editor={editor} {...sectionProps('rocks')} />
      <SculptLayersPanel terrain={terrain} editor={editor} {...sectionProps('layers')} />
      <ModifierStackPanel terrain={terrain} editor={editor} {...sectionProps('modifiers')} />
    </aside>
  )
}
