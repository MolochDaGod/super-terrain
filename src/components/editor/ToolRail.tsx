import type { LucideIcon } from 'lucide-react'
import {
  ArrowDown,
  ArrowUp,
  CircleDotDashed,
  Grid3X3,
  MousePointer2,
  Pickaxe,
  Waves,
} from 'lucide-react'
import type { EditorStore, EditorTool } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../../terrain/react/hooks'

interface ToolDefinition {
  id: EditorTool
  label: string
  shortcut: string
  icon: LucideIcon
}

const TOOLS: ToolDefinition[] = [
  { id: 'select', label: 'Inspect', shortcut: '1', icon: MousePointer2 },
  { id: 'raise', label: 'Raise', shortcut: '2', icon: ArrowUp },
  { id: 'lower', label: 'Lower', shortcut: '3', icon: ArrowDown },
  { id: 'smooth', label: 'Smooth', shortcut: '4', icon: Waves },
  { id: 'flatten', label: 'Flatten', shortcut: '5', icon: CircleDotDashed },
  { id: 'remesh', label: 'Density', shortcut: '6', icon: Grid3X3 },
  { id: 'tunnel', label: 'Tunnel', shortcut: '7', icon: Pickaxe },
]

interface ToolRailProps {
  editor: EditorStore
}

export function ToolRail({ editor }: ToolRailProps) {
  const snapshot = useEditorSnapshot(editor)
  return (
    <nav
      aria-label="Terrain tools"
      className="pointer-events-auto absolute left-3 top-[68px] z-20 flex w-12 flex-col gap-1 rounded-xl border border-white/[0.09] bg-[#0b1312]/92 p-1.5 shadow-2xl shadow-black/30 backdrop-blur-xl"
    >
      {TOOLS.map(({ id, label, shortcut, icon: Icon }, index) => (
        <div key={id}>
          {index === 5 && <div className="mx-1 my-1.5 h-px bg-white/[0.08]" />}
          <button
            type="button"
            aria-label={`${label} tool (${shortcut})`}
            aria-pressed={snapshot.tool === id}
            title={`${label} · ${shortcut}`}
            className="tool-button group relative"
            data-active={snapshot.tool === id}
            onClick={() => editor.patch({ tool: id, status: `${label} tool active` })}
          >
            <Icon size={17} strokeWidth={1.7} />
            <span className="pointer-events-none absolute left-[50px] whitespace-nowrap rounded-md border border-white/10 bg-[#0b1312] px-2 py-1 text-[10px] text-white/80 opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
              {label}
              <kbd className="ml-2 text-white/35">{shortcut}</kbd>
            </span>
          </button>
        </div>
      ))}
    </nav>
  )
}
