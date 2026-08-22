import { useState } from 'react'
import { Dices, Globe2, X } from 'lucide-react'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import {
  PRESET_DESCRIPTIONS,
  PRESET_LABELS,
  defaultRecipeFor,
  type WorldPreset,
  type WorldRecipe,
} from '../../terrain/world/worldRecipe'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { RangeField } from './RangeField'
import { randomSeed } from './editorActions'

const PRESETS: WorldPreset[] = ['showcase', 'wild', 'flat']

/**
 * The new-world sheet.
 *
 * A world is a seed plus a handful of counts, so this is deliberately short.
 * The generators behind it are the ones the shipped scene uses — the same
 * ridged-multifractal height field, the same drainage, the same Boolean outcrop
 * patches — which is the only reason a random seed is worth offering at all: a
 * cheaper generator hiding behind a "new world" button would just be a way to
 * make every world after the first one worse than the demo.
 */
export function NewWorldDialog(props: {
  editor: EditorStore
  current: WorldRecipe
  onCreate: (recipe: WorldRecipe) => void
}) {
  const snapshot = useEditorSnapshot(props.editor)
  if (!snapshot.showNewWorld) return null
  // Mounted only while open, so the draft starts from the world that is
  // actually loaded every time rather than from whatever was typed and
  // abandoned the last time the sheet was opened.
  return <NewWorldSheet {...props} />
}

function NewWorldSheet({
  editor,
  current,
  onCreate,
}: {
  editor: EditorStore
  current: WorldRecipe
  onCreate: (recipe: WorldRecipe) => void
}) {
  const [draft, setDraft] = useState<WorldRecipe>(current)

  const close = () => editor.patch({ showNewWorld: false })
  const choosePreset = (preset: WorldPreset) =>
    setDraft(
      defaultRecipeFor(
        preset,
        // The demo's seed is authored for the demo's composition, so carrying it
        // into a generated world would hand out the same range every time
        // someone asked for a new one. Keep a seed the user chose; replace one
        // that only came from the preset they are leaving.
        draft.preset === 'showcase' ? randomSeed() : draft.seed,
      ),
    )
  const isShowcase = draft.preset === 'showcase'

  return (
    <div className="pointer-events-auto absolute inset-0 z-50 grid place-items-center bg-black/45 p-5 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="New world"
        className="max-h-[86svh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/[0.1] bg-[#0b1412] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-lg border border-[#77e8be]/25 bg-[#77e8be]/10 text-[#a6f2d5]">
              <Globe2 size={14} strokeWidth={1.8} />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-white/88">New world</h2>
              <p className="mt-0.5 text-[11px] text-white/36">
                This replaces everything currently in the editor.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="grid size-8 place-items-center rounded-md text-white/40 hover:bg-white/[0.06] hover:text-white"
            onClick={close}
          >
            <X size={15} />
          </button>
        </header>

        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-pressed={draft.preset === preset}
                data-active={draft.preset === preset}
                className="preset-card"
                onClick={() => choosePreset(preset)}
              >
                <span className="text-[12px] text-white/82">{PRESET_LABELS[preset]}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-white/38">
                  {PRESET_DESCRIPTIONS[preset]}
                </span>
              </button>
            ))}
          </div>

          {!isShowcase && (
            <div className="space-y-3 rounded-lg border border-white/[0.07] bg-white/[0.018] p-3">
              <div className="flex items-end gap-1.5">
                <label className="flex-1">
                  <span className="panel-title mb-1.5 block">Seed</span>
                  <input
                    type="number"
                    min={1}
                    value={draft.seed}
                    className="text-input font-mono"
                    onChange={(event) =>
                      setDraft({ ...draft, seed: Math.max(1, Number(event.target.value) || 1) })
                    }
                  />
                </label>
                <button
                  type="button"
                  aria-label="Random seed"
                  title="Random seed"
                  className="panel-button shrink-0 px-2.5"
                  onClick={() => setDraft({ ...draft, seed: randomSeed() })}
                >
                  <Dices size={13} />
                </button>
              </div>

              <RangeField
                label="Granite erratics"
                value={draft.rocks}
                min={0}
                max={24}
                step={1}
                onChange={(rocks) => setDraft({ ...draft, rocks })}
              />

              <Toggle
                label="Outcrop patches"
                hint="Boolean granite cutting through the slopes, seeded from the terrain"
                value={draft.outcrops}
                onChange={(outcrops) => setDraft({ ...draft, outcrops })}
              />
              <Toggle
                label="Flood the low ground"
                hint="Standing water wherever the drainage runs. Paintable afterwards."
                value={draft.water}
                onChange={(water) => setDraft({ ...draft, water })}
              />
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-white/34">
            Terrain compiles in the background, so a new world fills in over a few
            seconds starting from the camera.
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-white/[0.08] px-5 py-3.5">
          <button type="button" className="panel-button px-3" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="panel-button px-3 text-[#b7f6df]"
            onClick={() => {
              editor.patch({ showNewWorld: false })
              onCreate(draft)
            }}
          >
            Create world
          </button>
        </footer>
      </section>
    </div>
  )
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className="flex w-full items-start gap-2.5 rounded-md p-1.5 text-left transition hover:bg-white/[0.03]"
      onClick={() => onChange(!value)}
    >
      <span
        aria-hidden
        data-active={value}
        className="mt-0.5 grid size-3.5 shrink-0 place-items-center rounded border border-white/15 data-[active=true]:border-[#77e8be]/45 data-[active=true]:bg-[#77e8be]/25"
      />
      <span className="min-w-0">
        <span className="block text-[11px] text-white/74">{label}</span>
        <span className="mt-0.5 block text-[10.5px] leading-relaxed text-white/32">{hint}</span>
      </span>
    </button>
  )
}
