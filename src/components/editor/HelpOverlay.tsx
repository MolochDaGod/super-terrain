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
        className="max-h-[86svh] w-full max-w-2xl overflow-y-auto overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0b1412] shadow-2xl"
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
              ['Orbit / Fly', 'Switch camera mode in the View menu'],
              ['LMB drag', 'Orbit in Camera and Select modes'],
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
              ['Q / 1 / X', 'Camera / Select / 3D cursor'],
              ['1—0', 'Select and sculpt tools'],
              ['K / P', 'Water / paint'],
              ['G / T / C', 'Density / tunnel / cave dig'],
              ['LMB drag', 'Apply active brush'],
              ['RMB click', 'Place the 3D cursor'],
              ['[ / ]', 'Change brush radius'],
              ['H', 'Toggle frame telemetry'],
            ]}
          />
          <HelpGroup
            title="Objects"
            rows={[
              ['W / E / R', 'Move / rotate / scale the selection'],
              ['F', 'Frame the selection'],
              ['⌘ / Ctrl + D', 'Duplicate rock or light'],
              ['Alt + H', 'Hide or show the selection'],
              ['Del', 'Delete the selection'],
              ['LMB click', 'Select or deselect, in Select mode'],
              ['Esc', 'Close dialog, deselect, clear cursor, Camera'],
            ]}
          />
          <HelpGroup
            title="Where things live"
            rows={[
              ['Menu bar', 'File, Edit, Selection, Add, View, Run, Export, Help'],
              ['Toolbar', 'Pointer modes, brushes, add and object verbs'],
              ['Left panel', 'Everything in the scene, as one list'],
              ['Right panel', 'Parameters for the tool and the selection'],
            ]}
          />
        </div>
        <div className="border-t border-white/[0.08] bg-white/[0.02] px-5 py-4 text-[11px] leading-relaxed text-white/38">
Verbs live on the menu bar and the toolbar, the scene lives on the left, and the right panel shows only what the current tool and the current selection actually have parameters for. Every edit stays non-destructive: strokes belong to layers, rocks and CSG volumes stay editable in the modifier stack, water is a painted mask over the terrain rather than a baked shoreline, and workers rebuild only dirty sections while the previous mesh stays visible.
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
            <kbd className="shrink-0 whitespace-nowrap rounded border border-white/[0.09] bg-white/[0.04] px-1.5 py-1 font-mono text-[11px] text-white/60">{key}</kbd>
            <span className="text-right text-[11px] text-white/34">{description}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
