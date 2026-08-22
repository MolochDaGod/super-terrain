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
            <p className="mt-1 text-[11px] text-white/36">Designed to keep navigation and editing independent.</p>
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
              ['Orbit / Fly', 'Switch camera mode in top bar'],
              ['LMB drag', 'Orbit in Inspect mode'],
              ['Alt + LMB', 'Orbit while editing'],
              ['RMB drag', 'Pan camera'],
              ['Wheel / middle', 'Zoom'],
              ['Fly: click', 'Capture mouse for free look'],
              ['W A S D', 'Move in Fly mode'],
              ['Q / E', 'Descend / ascend in Fly'],
              ['Shift', 'Boost Fly speed'],
              ['Esc', 'Release Fly mouse'],
            ]}
          />
          <HelpGroup
            title="Edit"
            rows={[
              ['1—0', 'Select sculpt tools'],
              ['P / G / T / C', 'Paint / density / tunnel / cave dig'],
              ['LMB drag', 'Apply active brush'],
              ['[ / ]', 'Change brush radius'],
              ['H', 'Toggle telemetry and stress tests'],
              ['Esc', 'Select / close dialog'],
            ]}
          />
        </div>
        <div className="border-t border-white/[0.08] bg-white/[0.02] px-5 py-4 text-[11px] leading-relaxed text-white/38">
          The inspector shows the active tool's parameters, then whatever is selected, then one scene section — switching tools opens the section that tool works with. Every edit stays non-destructive: strokes belong to layers, rocks and CSG volumes stay editable in the modifier stack, and workers rebuild only dirty sections while the previous mesh stays visible.
        </div>
      </section>
    </div>
  )
}

function HelpGroup({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div>
      <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#a6f2d5]/70">{title}</h3>
      <div className="space-y-2.5">
        {rows.map(([key, description]) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <kbd className="rounded border border-white/[0.09] bg-white/[0.04] px-1.5 py-1 font-mono text-[11px] text-white/60">{key}</kbd>
            <span className="text-right text-[11px] text-white/34">{description}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
