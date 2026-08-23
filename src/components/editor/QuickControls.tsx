import { Gauge, Layers } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { DPR_OPTIONS, OVERLAY_OPTIONS, QUALITY_OPTIONS } from './viewOptions'

/**
 * The two view settings that get changed constantly.
 *
 * Render mode and resolution are what a user toggles between while judging a
 * frame, and the overlay is what they flick on to find out why the frame looks
 * the way it does. Both live in the View menu as well; a setting used this often
 * should not cost two clicks and a menu traversal, so they are also pinned
 * beside the viewport edge they belong to.
 */

export function RenderQuickControls({ editor }: { editor: EditorStore }) {
  const snapshot = useEditorSnapshot(editor)

  return (
    <div
      role="group"
      aria-label="Render quality"
      // Sit just inside the viewport, clear of the scene panel and status bar.
      className="pointer-events-auto absolute bottom-9 left-[256px] z-20 hidden h-9 items-center gap-2 rounded-lg border border-white/[0.09] bg-[#0b1312]/92 px-2 shadow-2xl shadow-black/30 backdrop-blur-xl xl:flex"
    >
      <Gauge size={12} className="shrink-0 text-white/28" />
      <Pills
        ariaLabel="Render mode"
        options={QUALITY_OPTIONS.map(({ value, short, hint, label }) => ({
          value,
          short,
          title: `${label} · ${hint}`,
        }))}
        value={snapshot.renderMode}
        onChange={(renderMode) => editor.patch({ renderMode })}
      />
      <span className="h-4 w-px bg-white/[0.09]" />
      <Pills
        ariaLabel="Resolution"
        options={DPR_OPTIONS.map(({ value, short, hint, label }) => ({
          value,
          short,
          title: `${label} · ${hint}`,
        }))}
        value={snapshot.dprMode}
        onChange={(dprMode) => editor.patch({ dprMode })}
      />
    </div>
  )
}

export function OverlayQuickControl({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  const snapshot = useEditorSnapshot(editor)

  return (
    <div
      role="group"
      aria-label="Terrain overlay"
      className="pointer-events-auto absolute bottom-9 right-[292px] z-20 hidden h-9 items-center gap-2 rounded-lg border border-white/[0.09] bg-[#0b1312]/92 px-2 shadow-2xl shadow-black/30 backdrop-blur-xl xl:flex"
    >
      <Layers size={12} className="shrink-0 text-white/28" />
      <Pills
        ariaLabel="Overlay"
        options={OVERLAY_OPTIONS.map(({ value, short, hint, label }) => ({
          value,
          short,
          title: `${label} · ${hint}`,
        }))}
        value={snapshot.overlay}
        onChange={(overlay) => {
          editor.patch({ overlay })
          terrain.setOverlay(overlay)
        }}
      />
    </div>
  )
}

function Pills<Value extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string
  options: { value: Value; short: string; title: string }[]
  value: Value
  onChange: (value: Value) => void
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex items-center gap-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          data-active={option.value === value}
          className="quick-pill"
          onClick={() => onChange(option.value)}
        >
          {option.short}
        </button>
      ))}
    </div>
  )
}
