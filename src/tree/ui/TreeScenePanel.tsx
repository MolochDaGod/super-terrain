import { useMemo, useState } from 'react'
import {
  Boxes,
  Layers3,
  Search,
  Shuffle,
  Sprout,
  TreePine,
  Trees,
} from 'lucide-react'
import { CollapsibleSection } from '../../components/editor/ui/Section'
import { EmptyHint } from '../../components/editor/ui/EmptyHint'
import { RangeField } from '../../components/editor/RangeField'
import type { FoliageEditorStore } from '../../foliage/FoliageEditorStore'
import { useFoliageSnapshot } from '../../foliage/react/useFoliageSnapshot'
import { FOLIAGE_SPECIES } from '../../foliage/foliageSpecies'
import { FOLIAGE_SURFACES } from '../../foliage/foliageSurfaces'
import { TREE_SPECIES_DEFINITIONS } from '../generator/speciesCatalog'
import { FOREST_PRESETS, type ForestPresetId } from '../forestPresets'
import type { TreeSpecies } from '../generator/types'
import {
  TREE_VARIATION_NAMES,
  treePrototypeId,
  type TreeSceneSection,
  type TreeEditorStore,
} from '../TreeEditorStore'
import { useTreeEditorSnapshot } from '../useTreeEditorSnapshot'

/**
 * What is in the forest.
 *
 * The catalogue, the generator, the floor palettes and the placed stems, in one
 * column, one section open at a time. Every one of these used to be somewhere
 * else — the generator inside the catalogue's scroll area, the palettes floating
 * over the middle of the viewport, the placements nowhere at all — which meant
 * the answer to "what is in this scene" was scattered across three overlays and
 * the answer to "how do I add to it" depended on which one you found first.
 */
export function TreeScenePanel({
  store,
  foliage,
}: {
  store: TreeEditorStore
  foliage: FoliageEditorStore
}) {
  const snapshot = useTreeEditorSnapshot(store)
  const sectionProps = (section: TreeSceneSection) => ({
    open: snapshot.openSection === section,
    onToggle: () =>
      store.patch({
        openSection: snapshot.openSection === section ? undefined : section,
      }),
  })

  return (
    <aside
      aria-label="Forest"
      className="pointer-events-auto absolute bottom-7 left-3 top-[46px] z-20 hidden w-[248px] overflow-y-auto rounded-lg border border-white/[0.09] bg-[#0b1312]/92 shadow-2xl shadow-black/30 backdrop-blur-xl lg:block"
    >
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
        <Trees size={12} strokeWidth={1.7} className="shrink-0 text-white/45" />
        <span className="panel-title min-w-0 flex-1 truncate">Forest</span>
        <span className="panel-meta font-mono">{snapshot.placements.length}</span>
      </div>

      <ForestGeneratorSection store={store} {...sectionProps('forest')} />
      <CatalogueSection store={store} {...sectionProps('catalogue')} />
      <FloorSection foliage={foliage} {...sectionProps('floor')} />
      <PlacementsSection store={store} {...sectionProps('placements')} />
    </aside>
  )
}

function ForestGeneratorSection({
  store,
  open,
  onToggle,
}: {
  store: TreeEditorStore
  open: boolean
  onToggle: () => void
}) {
  const snapshot = useTreeEditorSnapshot(store)
  const preset = FOREST_PRESETS.find((entry) => entry.id === snapshot.forestPreset)
    ?? FOREST_PRESETS[0]

  return (
    <CollapsibleSection
      icon={Sprout}
      title="Generate forest"
      open={open}
      onToggle={onToggle}
    >
      <label className="block space-y-1.5">
        <span className="text-[10px] uppercase tracking-[0.12em] text-white/30">
          Forest type
        </span>
        <select
          className="text-input"
          value={snapshot.forestPreset}
          onChange={(event) =>
            store.patch({ forestPreset: event.target.value as ForestPresetId })
          }
        >
          {FOREST_PRESETS.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.label}</option>
          ))}
        </select>
      </label>
      <p className="text-[10px] leading-relaxed text-white/32">{preset.description}</p>

      <RangeField
        label="Density"
        hint={densityHint(snapshot.forestDensity)}
        value={snapshot.forestDensity}
        min={0.4}
        max={1.6}
        step={0.05}
        onChange={(forestDensity) => store.patch({ forestDensity })}
      />
      <RangeField
        label="Radius"
        value={snapshot.forestRadius}
        min={20}
        max={190}
        step={5}
        unit=" m"
        onChange={(forestRadius) => store.patch({ forestRadius })}
      />

      <label className="block space-y-1.5">
        <span className="text-[10px] uppercase tracking-[0.12em] text-white/30">Seed</span>
        <input
          className="text-input font-mono"
          type="number"
          min={1}
          max={0x7fffffff}
          value={snapshot.forestSeed}
          onChange={(event) => store.patch({ forestSeed: Number(event.target.value) })}
        />
      </label>

      <div className="grid grid-cols-[1fr_auto] gap-1.5">
        <button
          type="button"
          className="panel-button justify-center"
          data-accent="mint"
          onClick={() => store.generateForest()}
        >
          <Sprout size={12} /> Generate
        </button>
        <button
          type="button"
          title="Generate a different seed"
          aria-label="Shuffle forest seed"
          className="icon-button size-8 border border-white/[0.07]"
          onClick={() => store.randomizeForest()}
        >
          <Shuffle size={12} />
        </button>
      </div>
      <button
        type="button"
        className="panel-button w-full justify-center"
        data-accent="coral"
        disabled={snapshot.placements.length === 0}
        onClick={() => store.clearForest()}
      >
        Clear forest
      </button>
    </CollapsibleSection>
  )
}

function CatalogueSection({
  store,
  open,
  onToggle,
}: {
  store: TreeEditorStore
  open: boolean
  onToggle: () => void
}) {
  const snapshot = useTreeEditorSnapshot(store)
  const [search, setSearch] = useState('')
  const species = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return TREE_SPECIES_DEFINITIONS
    return TREE_SPECIES_DEFINITIONS.filter(
      (entry) =>
        entry.label.toLowerCase().includes(query) || entry.group.includes(query),
    )
  }, [search])

  return (
    <CollapsibleSection
      icon={TreePine}
      title="Catalogue"
      badge={TREE_SPECIES_DEFINITIONS.length}
      open={open}
      onToggle={onToggle}
    >
      <label className="flex h-7 items-center gap-2 rounded-md border border-white/[0.07] bg-black/15 px-2">
        <Search size={11} className="text-white/28" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search species…"
          className="min-w-0 flex-1 bg-transparent text-[11px] text-white/65 outline-none placeholder:text-white/22"
        />
      </label>

      {species.length === 0 && <EmptyHint>No species matches that search.</EmptyHint>}

      <div className="space-y-1">
        {species.map((definition, index) => {
          const placed = snapshot.placements.filter(
            (placement) =>
              snapshot.prototypes[placement.prototypeId]?.species === definition.id,
          ).length
          return (
            <details
              key={definition.id}
              open={Boolean(search) || index < 2 ? true : undefined}
              className="overflow-hidden rounded-md border border-white/[0.055] bg-black/10"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[11px] text-white/58 transition hover:bg-white/[0.025] hover:text-white/78">
                <span className="size-1.5 shrink-0 rounded-full bg-[#77e8be]/45" />
                <span className="min-w-0 flex-1 truncate">{definition.label}</span>
                {placed > 0 && (
                  <span className="panel-meta font-mono text-[#a6f2d5]/60">{placed}</span>
                )}
              </summary>
              <div className="grid grid-cols-2 gap-1 border-t border-white/[0.045] p-1.5">
                {TREE_VARIATION_NAMES.map((name, variation) => {
                  const id = treePrototypeId(definition.id, variation)
                  const prototype = snapshot.prototypes[id]
                  const count = snapshot.placements.filter(
                    (placement) => placement.prototypeId === id,
                  ).length
                  return (
                    <button
                      key={id}
                      type="button"
                      title={`${name} · a distinct deterministic topology for ${definition.label}`}
                      data-active={snapshot.armedPrototypeId === id}
                      className="rounded border border-white/[0.055] bg-white/[0.018] px-2 py-1.5 text-left transition hover:border-[#77e8be]/20 hover:bg-[#77e8be]/[0.045] data-[active=true]:border-[#77e8be]/35 data-[active=true]:bg-[#77e8be]/10"
                      onClick={() =>
                        store.armPlacement(definition.id as TreeSpecies, variation)
                      }
                    >
                      <span className="block truncate text-[10px] text-white/58">{name}</span>
                      <span className="mt-0.5 block font-mono text-[9px] text-white/25">
                        {prototype?.building ? 'building' : count ? `${count}×` : 'plant'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </details>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}

function FloorSection({
  foliage,
  open,
  onToggle,
}: {
  foliage: FoliageEditorStore
  open: boolean
  onToggle: () => void
}) {
  const snapshot = useFoliageSnapshot(foliage)
  const armed = snapshot.layer === 'surface'
    ? FOLIAGE_SURFACES.find((entry) => entry.id === snapshot.surface)?.label
    : FOLIAGE_SPECIES.find((entry) => entry.id === snapshot.species)?.label

  return (
    <CollapsibleSection
      icon={Layers3}
      title="Ground cover"
      badge={armed}
      open={open}
      onToggle={onToggle}
    >
      <Palette
        label="Floor"
        active={snapshot.layer === 'surface'}
        entries={FOLIAGE_SURFACES.map((entry) => ({
          id: entry.id,
          label: entry.label,
          hint: entry.hint,
          swatch: entry.swatch,
          selected: snapshot.layer === 'surface' && snapshot.surface === entry.id,
        }))}
        round={false}
        onSelect={(id) =>
          foliage.patch({
            surface: id as typeof snapshot.surface,
            layer: 'surface',
            tool: snapshot.tool === 'none' ? 'paint' : snapshot.tool,
            status: 'Ground layer armed',
          })
        }
      />
      <Palette
        label="Plants"
        active={snapshot.layer === 'plants'}
        entries={FOLIAGE_SPECIES.map((entry) => ({
          id: entry.id,
          label: entry.label,
          hint: entry.hint,
          swatch: entry.swatch,
          selected: snapshot.layer === 'plants' && snapshot.species === entry.id,
        }))}
        round
        onSelect={(id) =>
          foliage.patch({
            species: id as typeof snapshot.species,
            layer: 'plants',
            tool: snapshot.tool === 'none' ? 'paint' : snapshot.tool,
            status: 'Plant armed',
          })
        }
      />
      <button
        type="button"
        className="panel-button w-full justify-center"
        aria-pressed={snapshot.visible}
        onClick={() =>
          foliage.patch({
            visible: !snapshot.visible,
            status: snapshot.visible ? 'Ground cover hidden' : 'Ground cover shown',
          })
        }
      >
        {snapshot.visible ? 'Hide ground cover' : 'Show ground cover'}
      </button>
    </CollapsibleSection>
  )
}

function Palette({
  label,
  active,
  entries,
  round,
  onSelect,
}: {
  label: string
  active: boolean
  entries: {
    id: string
    label: string
    hint: string
    swatch: string
    selected: boolean
  }[]
  round: boolean
  onSelect: (id: string) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-armed={active}
      className="space-y-1.5 data-[armed=false]:opacity-60"
    >
      <span className="text-[10px] uppercase tracking-[0.12em] text-white/30">{label}</span>
      <div className="grid grid-cols-2 gap-1">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={entry.selected}
            data-active={entry.selected}
            title={entry.hint}
            className="flex items-center gap-1.5 rounded border border-white/[0.05] bg-black/10 px-1.5 py-1 text-left text-[10px] text-white/45 transition hover:text-white/85 data-[active=true]:border-[#77e8be]/30 data-[active=true]:bg-[#77e8be]/10 data-[active=true]:text-white/90"
            onClick={() => onSelect(entry.id)}
          >
            <span
              aria-hidden="true"
              className={`size-2.5 shrink-0 ring-1 ring-black/40 ${round ? 'rounded-full' : 'rounded-sm'}`}
              style={{ background: entry.swatch }}
            />
            <span className="min-w-0 truncate">{entry.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function PlacementsSection({
  store,
  open,
  onToggle,
}: {
  store: TreeEditorStore
  open: boolean
  onToggle: () => void
}) {
  const snapshot = useTreeEditorSnapshot(store)
  const selectedPrototypeId = snapshot.placements.find(
    (placement) => placement.id === snapshot.selectedPlacementId,
  )?.prototypeId

  // Grouped by prototype rather than listed one row per stem: a generated
  // forest is two thousand placements and eleven prototypes, and the list that
  // is worth reading is the second one.
  const groups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const placement of snapshot.placements) {
      counts.set(placement.prototypeId, (counts.get(placement.prototypeId) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count, prototype: snapshot.prototypes[id] }))
      .sort((a, b) => b.count - a.count)
  }, [snapshot.placements, snapshot.prototypes])

  return (
    <CollapsibleSection
      icon={Boxes}
      title="Placed stems"
      badge={snapshot.placements.length}
      open={open}
      onToggle={onToggle}
    >
      {groups.length === 0 && (
        <EmptyHint>Nothing planted yet. Generate a forest, or plant from the catalogue.</EmptyHint>
      )}
      {groups.map(({ id, count, prototype }) => (
        <button
          key={id}
          type="button"
          data-selected={selectedPrototypeId === id}
          className="list-row w-full text-left"
          onClick={() => {
            const first = snapshot.placements.find(
              (placement) => placement.prototypeId === id,
            )
            if (first) store.selectPlacement(first.id)
          }}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] text-white/72">
              {prototype?.variationName ?? 'Variation'}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[10px] text-white/28">
              {(prototype?.species ?? id).replaceAll('-', ' ')}
              {prototype?.building ? ' · building' : prototype?.dirty ? ' · edited' : ''}
            </span>
          </span>
          <span className="panel-meta shrink-0 font-mono">{count}</span>
        </button>
      ))}
    </CollapsibleSection>
  )
}

function densityHint(value: number): string {
  if (value <= 0.7) return 'open'
  if (value >= 1.3) return 'closed'
  return 'natural'
}
