import { X } from 'lucide-react'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../../terrain/react/hooks'

export function HelpOverlay({ editor }: { editor: EditorStore }) {
  const snapshot = useEditorSnapshot(editor)
  if (!snapshot.showHelp) return null
  return (
    <div className="pointer-events-auto absolute inset-0 z-50 grid place-items-center bg-black/40 p-5 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Editor help"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0b1412] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-white/88">World editor controls</h2>
            <p className="mt-1 text-[10px] text-white/36">Designed to keep navigation and editing independent.</p>
          </div>
          <button
            type="button"
            aria-label="Close help"
            className="grid size-8 place-items-center rounded-md text-white/40 hover:bg-white/[0.06] hover:text-white"
            onClick={() => editor.patch({ showHelp: false })}
          >
            <X size={15} />
          </button>
        </header>
        <div className="grid gap-6 p-5 sm:grid-cols-2">
          <HelpGroup
            title="Navigate"
            rows={[
              ['LMB drag', 'Orbit in Inspect mode'],
              ['Alt + LMB', 'Orbit while editing'],
              ['RMB drag', 'Pan camera'],
              ['Wheel / middle', 'Zoom'],
              ['W A S D', 'Fly laterally'],
              ['Q / E', 'Descend / ascend'],
              ['Shift', 'Fast movement'],
            ]}
          />
          <HelpGroup
            title="Edit"
            rows={[
              ['1—7', 'Select terrain tool'],
              ['LMB drag', 'Apply active brush'],
              ['[ / ]', 'Change brush radius'],
              ['H', 'Toggle telemetry'],
              ['Esc', 'Select / close dialog'],
            ]}
          />
        </div>
        <div className="border-t border-white/[0.08] bg-white/[0.02] px-5 py-4 text-[10px] leading-relaxed text-white/38">
          Heightfield strokes move along world Y. Mesh strokes follow the picked surface normal in XYZ. One press/drag creates one selectable modifier containing all sampled dabs; it can then be enabled, moved, rotated, scaled, or deleted. Workers recompile only dirty sections while the previous mesh remains visible.
        </div>
      </section>
    </div>
  )
}

function HelpGroup({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div>
      <h3 className="mb-3 text-[9px] font-semibold uppercase tracking-[0.15em] text-[#a6f2d5]/70">{title}</h3>
      <div className="space-y-2.5">
        {rows.map(([key, description]) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <kbd className="rounded border border-white/[0.09] bg-white/[0.04] px-1.5 py-1 font-mono text-[9px] text-white/60">{key}</kbd>
            <span className="text-right text-[9px] text-white/34">{description}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
