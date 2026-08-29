import { useEffect, useRef, useState } from 'react'
import {
  Brush,
  Eraser,
  Hand,
  PaintBucket,
  Sprout,
  Trash2,
  Wind,
} from 'lucide-react'
import { RangeField } from '../../components/editor/RangeField'
import type { FoliageEditorStore, FoliageTool } from '../FoliageEditorStore'
import { FOLIAGE_SPECIES, type FoliageSpeciesId } from '../foliageSpecies'
import { FOLIAGE_SURFACES, type FoliageSurfaceId } from '../foliageSurfaces'
import { useFoliageSnapshot } from './useFoliageSnapshot'

const TOOLS: { value: FoliageTool; label: string; icon: typeof Brush; hint: string }[] = [
  {
    value: 'none',
    label: 'Look',
    icon: Hand,
    hint: 'Camera only · the brush is disarmed',
  },
  {
    value: 'paint',
    label: 'Grow',
    icon: Brush,
    hint: 'Drag on the ground to grow the selected cover',
  },
  {
    value: 'erase',
    label: 'Clear',
    icon: Eraser,
    hint: 'Drag on the ground to thin the plants and the floor under them',
  },
]

/**
 * The ground-cover brush, over the middle of the viewport.
 *
 * It sits above the scene rather than in a side panel because painting is a
 * direct-manipulation task: the controls that change what the next drag does
 * belong next to where the user is looking, not eight hundred pixels away in a
 * stack of collapsed sections.
 */
export function FoliageToolbar({ store }: { store: FoliageEditorStore }) {
  const snapshot = useFoliageSnapshot(store)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const armed = snapshot.tool !== 'none'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return
      if (event.key === 'Escape' && store.getSnapshot().tool !== 'none') {
        store.patch({ tool: 'none', status: 'Brush disarmed' })
      }
      if (event.key === '[' || event.key === ']') {
        const current = store.getSnapshot()
        const step = current.radius * (event.key === '[' ? -0.18 : 0.18)
        store.patch({ radius: clamp(current.radius + step, 0.5, 60) })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [store])

  return (
    <div className="pointer-events-none absolute inset-x-0 top-11 z-30 flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-[min(96vw,72rem)] flex-col items-center gap-1.5">
        <div className="flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-[#07100f]/92 p-1 shadow-2xl backdrop-blur-xl">
          <ToolbarToggle
            active={snapshot.visible}
            icon={Sprout}
            label="Ground cover"
            onClick={() =>
              store.patch({
                visible: !snapshot.visible,
                status: snapshot.visible ? 'Ground cover hidden' : 'Ground cover shown',
              })
            }
          />

          <Divider />

          <div className="flex items-center gap-0.5">
            {TOOLS.map(({ value, label, icon: Icon, hint }) => (
              <button
                key={value}
                type="button"
                title={hint}
                aria-pressed={snapshot.tool === value}
                data-active={snapshot.tool === value}
                className="flex h-7 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-[10px] text-white/45 transition hover:text-white/85 data-[active=true]:border-white/[0.09] data-[active=true]:bg-white/[0.08] data-[active=true]:text-[#b7f6df]"
                onClick={() =>
                  store.patch({
                    tool: value,
                    status:
                      value === 'none'
                        ? 'Brush disarmed'
                        : `${label} · drag on the ground, right-drag to orbit`,
                  })
                }
              >
                <Icon size={12} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          <Divider />

          <CompactRange
            label="Size"
            value={snapshot.radius}
            min={0.5}
            max={60}
            step={0.5}
            suffix="m"
            onChange={(radius) => store.patch({ radius })}
          />
          <CompactRange
            label="Flow"
            value={snapshot.flow}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(flow) => store.patch({ flow })}
          />

          <Divider />

          <ToolbarToggle
            active={settingsOpen}
            icon={Wind}
            label="Density and wind"
            onClick={() => setSettingsOpen((open) => !open)}
          />
          <IconButton
            icon={PaintBucket}
            label={`Fill the whole field with ${armedLabel(snapshot)}`}
            onClick={() => {
              store.enqueue({ kind: 'fill' })
              store.patch({ status: `Filled with ${armedLabel(snapshot)}` })
            }}
          />
          <IconButton
            icon={Sprout}
            label="Regrow the preset's floor from scratch"
            onClick={() => {
              store.enqueue({ kind: 'reseed' })
              store.patch({ status: 'Floor regrown from the preset' })
            }}
          />
          <IconButton
            icon={Trash2}
            label="Clear every plant and every ground layer"
            danger
            onClick={() => {
              store.enqueue({ kind: 'clear' })
              store.patch({ status: 'Floor and ground cover cleared' })
            }}
          />
        </div>

        {/* Two palettes, because the floor and the things standing on it are
            two different sets of data. Picking from either arms that layer,
            so a brush always knows which field it is writing. */}
        <SurfaceRow
          surface={snapshot.surface}
          active={snapshot.layer === 'surface'}
          armed={armed}
          onSelect={(surface) =>
            store.patch({
              surface,
              layer: 'surface',
              tool: snapshot.tool === 'none' ? 'paint' : snapshot.tool,
              status: `${surfaceLabelFor(surface)} selected · ground layer`,
            })
          }
        />

        <SpeciesRow
          species={snapshot.species}
          active={snapshot.layer === 'plants'}
          armed={armed}
          onSelect={(species) =>
            store.patch({
              species,
              layer: 'plants',
              tool: snapshot.tool === 'none' ? 'paint' : snapshot.tool,
              status: `${labelFor(species)} selected`,
            })
          }
        />

        {settingsOpen && <SettingsPanel store={store} />}
      </div>
    </div>
  )
}

function SurfaceRow({
  surface,
  active,
  armed,
  onSelect,
}: {
  surface: FoliageSurfaceId
  active: boolean
  armed: boolean
  onSelect: (surface: FoliageSurfaceId) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Ground layer"
      data-armed={armed && active}
      className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-white/[0.07] bg-[#07100f]/88 p-1 shadow-xl backdrop-blur-xl data-[armed=false]:opacity-55"
    >
      <span className="shrink-0 px-1.5 text-[9px] uppercase tracking-wider text-white/30">
        Floor
      </span>
      {FOLIAGE_SURFACES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="radio"
          aria-checked={active && surface === entry.id}
          data-active={active && surface === entry.id}
          title={entry.hint}
          className="flex h-6.5 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-2 py-1 text-[10px] text-white/45 transition hover:text-white/85 data-[active=true]:border-white/[0.09] data-[active=true]:bg-white/[0.08] data-[active=true]:text-white/90"
          onClick={() => onSelect(entry.id)}
        >
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-sm ring-1 ring-black/40"
            style={{ background: entry.swatch }}
          />
          <span className="whitespace-nowrap">{entry.label}</span>
        </button>
      ))}
    </div>
  )
}

function SpeciesRow({
  species,
  active,
  armed,
  onSelect,
}: {
  species: FoliageSpeciesId
  active: boolean
  armed: boolean
  onSelect: (species: FoliageSpeciesId) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Ground cover type"
      data-armed={armed && active}
      className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-white/[0.07] bg-[#07100f]/88 p-1 shadow-xl backdrop-blur-xl data-[armed=false]:opacity-55"
    >
      <span className="shrink-0 px-1.5 text-[9px] uppercase tracking-wider text-white/30">
        Plants
      </span>
      {FOLIAGE_SPECIES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="radio"
          aria-checked={active && species === entry.id}
          data-active={active && species === entry.id}
          title={entry.hint}
          className="flex h-6.5 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-2 py-1 text-[10px] text-white/45 transition hover:text-white/85 data-[active=true]:border-white/[0.09] data-[active=true]:bg-white/[0.08] data-[active=true]:text-white/90"
          onClick={() => onSelect(entry.id)}
        >
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full ring-1 ring-black/40"
            style={{ background: entry.swatch }}
          />
          <span className="whitespace-nowrap">{entry.label}</span>
        </button>
      ))}
    </div>
  )
}

function SettingsPanel({ store }: { store: FoliageEditorStore }) {
  const snapshot = useFoliageSnapshot(store)
  return (
    <section className="w-[19rem] space-y-3 rounded-xl border border-white/[0.08] bg-[#07100f]/94 p-3 shadow-2xl backdrop-blur-xl">
      <RangeField
        label="Abundance"
        hint="clumps placed"
        value={snapshot.density}
        min={0.05}
        max={1}
        step={0.05}
        onChange={(density) => store.patch({ density })}
      />
      <RangeField
        label="Brush edge"
        hint="0 feathered"
        value={snapshot.hardness}
        min={0}
        max={0.95}
        step={0.05}
        onChange={(hardness) => store.patch({ hardness })}
      />
      <div className="h-px bg-white/[0.06]" />
      <RangeField
        label="Wind"
        value={snapshot.wind.strength}
        min={0}
        max={1.4}
        step={0.05}
        onChange={(strength) => store.patchWind({ strength })}
      />
      <RangeField
        label="Gust size"
        unit=" m"
        value={snapshot.wind.gustScale}
        min={3}
        max={60}
        step={1}
        onChange={(gustScale) => store.patchWind({ gustScale })}
      />
      <RangeField
        label="Gust speed"
        value={snapshot.wind.gustSpeed}
        min={0}
        max={4}
        step={0.05}
        onChange={(gustSpeed) => store.patchWind({ gustSpeed })}
      />
      <RangeField
        label="Wind heading"
        unit=" rad"
        value={snapshot.wind.heading}
        min={0}
        max={6.28}
        step={0.05}
        onChange={(heading) => store.patchWind({ heading })}
      />
      <p className="text-[10px] leading-relaxed text-white/35">
        Left-drag paints. Right-drag orbits while a brush is armed. Esc disarms,
        <span className="font-mono text-white/50"> [ </span> and
        <span className="font-mono text-white/50"> ] </span> resize the brush.
      </p>
    </section>
  )
}

function CompactRange({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (value: number) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <label
      className="flex h-7 items-center gap-2 rounded-lg px-2 text-[10px] text-white/45"
      title={`${label}: ${value}${suffix}`}
    >
      <span className="shrink-0">{label}</span>
      <input
        ref={input}
        className="terrain-range h-1 w-20"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{
          '--range-progress': `${((value - min) / (max - min)) * 100}%`,
        } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-9 shrink-0 text-right font-mono tabular-nums text-[#b7f6df]">
        {step >= 1 ? Math.round(value) : value.toFixed(2)}
        {suffix}
      </span>
    </label>
  )
}

function ToolbarToggle({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  icon: typeof Brush
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-active={active}
      className="grid size-7 place-items-center rounded-lg border border-transparent text-white/40 transition hover:text-white/85 data-[active=true]:border-[#77e8be]/25 data-[active=true]:bg-[#77e8be]/10 data-[active=true]:text-[#a6f2d5]"
      onClick={onClick}
    >
      <Icon size={13} />
    </button>
  )
}

function IconButton({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: typeof Brush
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-danger={Boolean(danger)}
      className="grid size-7 place-items-center rounded-lg border border-transparent text-white/40 transition hover:border-white/[0.09] hover:bg-white/[0.06] hover:text-white/85 data-[danger=true]:hover:border-[#ff9d78]/25 data-[danger=true]:hover:text-[#ff9d78]"
      onClick={onClick}
    >
      <Icon size={13} />
    </button>
  )
}

function Divider() {
  return <span aria-hidden="true" className="h-5 w-px bg-white/[0.08]" />
}

function labelFor(id: FoliageSpeciesId): string {
  return FOLIAGE_SPECIES.find((species) => species.id === id)?.label ?? id
}

function surfaceLabelFor(id: FoliageSurfaceId): string {
  return FOLIAGE_SURFACES.find((surface) => surface.id === id)?.label ?? id
}

function armedLabel(snapshot: {
  layer: string
  species: FoliageSpeciesId
  surface: FoliageSurfaceId
}): string {
  return snapshot.layer === 'surface'
    ? surfaceLabelFor(snapshot.surface)
    : labelFor(snapshot.species)
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
