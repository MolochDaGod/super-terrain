import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { TOOLS } from './tools'

// Inspect is a viewport action, not a brush: it lives on the object toolbar
// with the transform modes, so the rail is only ever "what does dragging do".
const BRUSHES = TOOLS.filter((tool) => tool.id !== 'select')

const GROUP_LABELS: Record<string, string> = {
  primary: 'Sculpt',
  detail: 'Detail',
  paint: 'Paint',
  topology: 'Topology',
}

/**
 * The tool rail: what the pointer does when it is dragged over the terrain.
 * Object verbs live on the object toolbar above it, so a tool here always
 * means a brush and never an action.
 */
export function ToolRail({ editor }: { editor: EditorStore }) {
  const snapshot = useEditorSnapshot(editor)
  return (
    <nav
      aria-label="Terrain tools"
      className="pointer-events-auto absolute left-3 top-[92px] z-20 flex w-11 flex-col gap-0.5 rounded-lg border border-white/[0.09] bg-[#0b1312]/92 p-1 shadow-2xl shadow-black/30 backdrop-blur-xl"
    >
      {BRUSHES.map((tool, index) => {
        const startsGroup = index > 0 && BRUSHES[index - 1]!.group !== tool.group
        return (
          <div key={tool.id}>
            {startsGroup && <div className="mx-1.5 my-1 h-px bg-white/[0.08]" />}
            <button
              type="button"
              aria-label={`${tool.label} tool (${tool.shortcut})`}
              aria-pressed={snapshot.tool === tool.id}
              className="tool-button group relative"
              data-active={snapshot.tool === tool.id}
              onClick={() =>
                editor.patch({
                  tool: tool.id,
                  status: `${tool.label} tool active`,
                })
              }
            >
              <tool.icon size={16} strokeWidth={1.7} />
              <span className="tool-tip">
                <span className="text-white/80">{tool.label}</span>
                <kbd className="ml-2 text-white/35">{tool.shortcut}</kbd>
                <span className="mt-1 block max-w-[220px] whitespace-normal text-[10px] leading-relaxed text-white/40">
                  {GROUP_LABELS[tool.group]} · {tool.description}
                </span>
              </span>
            </button>
          </div>
        )
      })}
    </nav>
  )
}
