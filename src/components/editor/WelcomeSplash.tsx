import { Droplets, Globe2, MousePointer2, Pickaxe, Sparkles, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { rememberWelcome } from './welcomeSeen'

/**
 * The first thing a new visitor sees.
 *
 * It exists because the editor opens onto a finished-looking landscape with no
 * indication that any of it can be touched. Four sentences and four pointers is
 * enough to fix that; anything longer would be a manual, and the Help dialog is
 * already where a manual belongs.
 */
export function WelcomeSplash({ editor }: { editor: EditorStore }) {
  const snapshot = useEditorSnapshot(editor)
  if (!snapshot.showWelcome) return null

  const close = () => {
    rememberWelcome()
    editor.patch({ showWelcome: false })
  }

  return (
    <div className="pointer-events-auto absolute inset-0 z-50 grid place-items-center bg-black/45 p-5 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Welcome"
        className="max-h-[86svh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/[0.1] bg-[#0b1412] shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.08] px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl border border-[#77e8be]/25 bg-[#77e8be]/10 text-[#a6f2d5]">
              <Sparkles size={16} strokeWidth={1.8} />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold text-white/90">
                Welcome to Superterrain
              </h2>
              <p className="mt-1 text-[11.5px] text-white/40">
                A terrain editor that streams and recompiles the world while you work in it.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-md text-white/40 hover:bg-white/[0.06] hover:text-white"
            onClick={close}
          >
            <X size={15} />
          </button>
        </header>

        <div className="space-y-4 px-6 py-5">
          <p className="text-[12px] leading-relaxed text-white/58">
            What you are looking at is a demo world — an alpine massif with caves cut
            through it, granite outcrops on its slopes and a flooded basin in front.
            None of it is a backdrop. Every part of it is made of the same editable
            pieces the tools create, so you can carve into it, plant things on it, or
            throw it away and generate your own.
          </p>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <Point
              icon={MousePointer2}
              title="Pick a mode, then drag"
              body="The toolbar above the viewport sets what dragging does — move the camera, select something, or push the ground around with a brush."
            />
            <Point
              icon={Pickaxe}
              title="Sculpting is non-destructive"
              body="Every stroke, tunnel and Boolean volume stays in the scene list on the left, where it can be turned off or deleted long after you made it."
            />
            <Point
              icon={Droplets}
              title="Water is a brush too"
              body="Flood and drain the ground with the water tool. The shoreline is cut by the terrain itself, so it follows anything you sculpt underneath."
            />
            <Point
              icon={Globe2}
              title="Make your own world"
              body="File · New world generates a fresh range from a random seed, or gives you flat ground to build on from nothing."
            />
          </div>

          <p className="text-[11px] leading-relaxed text-white/34">
            Press <kbd className="rounded border border-white/[0.09] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-white/60">?</kbd> at any time for the full list of controls.
            You can reopen this from the Help menu.
          </p>
        </div>

        <footer className="flex items-center justify-end border-t border-white/[0.08] px-6 py-4">
          <button type="button" className="panel-button px-3 text-[#b7f6df]" onClick={close}>
            Start exploring
          </button>
        </footer>
      </section>
    </div>
  )
}

function Point({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon
  title: string
  body: string
}) {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.018] p-3">
      <div className="flex items-center gap-2">
        <Icon size={13} strokeWidth={1.8} className="shrink-0 text-[#a6f2d5]" />
        <span className="text-[11.5px] font-medium text-white/78">{title}</span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-white/40">{body}</p>
    </div>
  )
}
