import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { TOOLS } from './tools'

export function ToolRail({ editor }: { editor: EditorStore }) {
  const snapshot = useEditorSnapshot(editor)
  return (
    <nav
      aria-label="Terrain tools"
      className="pointer-events-auto absolute left-3 top-[68px] z-20 flex w-12 flex-col gap-1 rounded-xl border border-white/[0.09] bg-[#0b1312]/92 p-1.5 shadow-2xl shadow-black/30 backdrop-blur-xl"
    >
      {TOOLS.map((tool, index) => (
        <div key={tool.id}>
          {index > 0 && TOOLS[index - 1]!.group !== tool.group && (
            <div className="mx-1 my-1.5 h-px bg-white/[0.08]" />
          )}
          <button
            type="button"
            aria-label={`${tool.label} tool (${tool.shortcut})`}
            aria-pressed={snapshot.tool === tool.id}
            title={`${tool.label} · ${tool.shortcut}`}
            className="tool-button group relative"
            data-active={snapshot.tool === tool.id}
            onClick={() =>
              editor.patch({ tool: tool.id, status: `${tool.label} tool active` })
            }
          >
            <tool.icon size={17} strokeWidth={1.7} />
            <span className="pointer-events-none absolute left-[50px] z-10 whitespace-nowrap rounded-md border border-white/10 bg-[#0b1312] px-2 py-1 text-[11px] text-white/80 opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
              {tool.label}
              <kbd className="ml-2 text-white/35">{tool.shortcut}</kbd>
            </span>
          </button>
        </div>
      ))}
    </nav>
  )
}
