import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Activity,
  Boxes,
  CircleDot,
  Copy,
  Eye,
  Gauge,
  GitBranch,
  Leaf,
  MousePointer2,
  Network,
  RefreshCw,
  ScanLine,
  Search,
  Shuffle,
  Sprout,
  Trash2,
  TreePine,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { RangeField } from '../components/editor/RangeField'
import { Section } from '../components/editor/ui/Section'
import { Segmented } from '../components/editor/ui/Segmented'
import {
  MAX_FOLIAGE_DENSITY,
  type TreeBolePlan,
  type TreeCrownForm,
  type TreeLodLevel,
  type TreeSpecies,
} from './generator/types'
import { TREE_SPECIES_DEFINITIONS } from './generator/speciesCatalog'
import {
  FOREST_PRESETS,
  type ForestPresetId,
} from './forestPresets'
import {
  TREE_VARIATION_NAMES,
  selectedTreePrototype,
  treePrototypeId,
  type TreeDebugMode,
  type TreeEditorStore,
} from './TreeEditorStore'
import { useTreeEditorSnapshot } from './useTreeEditorSnapshot'

const BOLE_OPTIONS = [
  { value: 'auto', label: 'Natural' },
  { value: 'single', label: 'Single' },
  { value: 'codominant', label: 'Forked' },
  { value: 'multistem', label: 'Multi' },
  { value: 'fused', label: 'Fused' },
] satisfies { value: TreeBolePlan; label: string }[]

const CROWN_OPTIONS = [
  { value: 'auto', label: 'Natural' },
  { value: 'full', label: 'Full' },
  { value: 'lopsided', label: 'Windward' },
  { value: 'stagheaded', label: 'Veteran' },
  { value: 'reiterated', label: 'Rebuilt' },
] satisfies { value: TreeCrownForm; label: string }[]

const DEBUG_OPTIONS: {
  value: TreeDebugMode
  short: string
  label: string
  icon: LucideIcon
}[] = [
  { value: 'surface', short: 'Lit', label: 'Surface', icon: Eye },
  { value: 'skeleton', short: 'Skel', label: 'Skeleton', icon: GitBranch },
  { value: 'hierarchy', short: 'Tree', label: 'Hierarchy', icon: Network },
  { value: 'continuations', short: 'Flow', label: 'Continuations', icon: Activity },
  { value: 'radii', short: 'Rad', label: 'Radii', icon: CircleDot },
  { value: 'contacts', short: 'Touch', label: 'Contacts', icon: ScanLine },
  { value: 'topology', short: 'Topo', label: 'Topology', icon: Boxes },
]

export function TreeWorkspacePanels({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  const selected = selectedTreePrototype(snapshot)
  return (
    <>
      <TreeToolbar store={store} />
      <TreeCatalogue store={store} />
      <TreeInspector store={store} />
      <TreeRenderControls store={store} />
      <TreeDiagnostics store={store} />
      <TreeEditorShortcuts store={store} />
      {snapshot.showHud && <TreePerformanceOverlay store={store} />}
      {!selected && snapshot.placements.length > 0 && (
        <div className="pointer-events-none absolute right-3 top-[96px] z-20 w-[268px] rounded-lg border border-white/[0.08] bg-[#0b1312]/88 p-4 text-center text-[10px] text-white/35 backdrop-blur-xl">
          Click a tree in the viewport to edit its shared prototype.
        </div>
      )}
    </>
  )
}

function TreeToolbar({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  const selected = selectedTreePrototype(snapshot)
  return (
    <div
      role="toolbar"
      aria-label="Forest tools"
      className="pointer-events-auto absolute left-1/2 top-[46px] z-20 flex h-9 -translate-x-1/2 items-center gap-0.5 rounded-lg border border-white/[0.09] bg-[#0b1312]/92 px-1 shadow-2xl shadow-black/30 backdrop-blur-xl"
    >
      <ToolButton
        icon={MousePointer2}
        label="Select"
        active={!snapshot.armedPrototypeId}
        onClick={() => store.cancelPlacement()}
      />
      <ToolButton
        icon={Sprout}
        label={snapshot.armedPrototypeId ? 'Place armed tree' : 'Choose a tree from the catalogue'}
        active={Boolean(snapshot.armedPrototypeId)}
        disabled={!snapshot.armedPrototypeId}
        onClick={() => undefined}
      />
      <Divider />
      <ToolButton
        icon={Copy}
        label="Duplicate instance"
        disabled={!snapshot.selectedPlacementId}
        onClick={() => store.duplicateSelected()}
      />
      <ToolButton
        icon={Trash2}
        label="Delete instance"
        danger
        disabled={!snapshot.selectedPlacementId}
        onClick={() => store.deleteSelected()}
      />
      <Divider />
      <ToolButton
        icon={Shuffle}
        label="New shared topology"
        disabled={!selected || selected.building}
        onClick={() => store.randomizeSelected()}
      />
      <ToolButton
        icon={RefreshCw}
        label="Recompile all matching trees"
        active={Boolean(selected?.dirty)}
        disabled={!selected || selected.building}
        onClick={() => store.recompileSelected()}
      />
    </div>
  )
}

function TreeCatalogue({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  const [search, setSearch] = useState('')
  const species = useMemo(() => {
    const query = search.trim().toLowerCase()
    return TREE_SPECIES_DEFINITIONS.filter((entry) =>
      !query || entry.label.toLowerCase().includes(query) || entry.group.includes(query),
    )
  }, [search])
  const forestPreset = FOREST_PRESETS.find(
    (preset) => preset.id === snapshot.forestPreset,
  ) ?? FOREST_PRESETS[0]

  return (
    <aside
      aria-label="Tree catalogue"
      className="pointer-events-auto absolute bottom-12 left-3 top-[94px] z-20 w-[276px] overflow-hidden rounded-lg border border-white/[0.09] bg-[#0b1312]/94 shadow-2xl shadow-black/30 backdrop-blur-xl"
    >
      <div className="border-b border-white/[0.07] p-3">
        <div className="flex items-center gap-2">
          <TreePine size={13} className="text-[#a6f2d5]/70" />
          <div>
            <h2 className="text-[11px] font-medium text-white/72">Tree catalogue</h2>
            <p className="mt-0.5 text-[9px] text-white/28">Choose a topology, then click the ground</p>
          </div>
        </div>
        <label className="mt-3 flex h-7 items-center gap-2 rounded-md border border-white/[0.07] bg-black/15 px-2">
          <Search size={11} className="text-white/28" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search species…"
            className="min-w-0 flex-1 bg-transparent text-[10px] text-white/65 outline-none placeholder:text-white/22"
          />
        </label>
      </div>
      <div className="h-[calc(100%-88px)] overflow-y-auto p-2">
        <section className="mb-2 overflow-hidden rounded-md border border-[#77e8be]/15 bg-[#77e8be]/[0.035]">
          <div className="flex items-center gap-2 border-b border-white/[0.055] px-2.5 py-2">
            <Sprout size={11} className="text-[#a6f2d5]/65" />
            <div className="min-w-0 flex-1">
              <h3 className="text-[10px] font-medium text-white/68">Generate full forest</h3>
              <p className="mt-0.5 text-[8px] text-white/27">Biome layout · shared instanced prototypes</p>
            </div>
          </div>
          <div className="space-y-2.5 p-2.5">
            <label className="block space-y-1">
              <span className="text-[8px] uppercase tracking-[0.12em] text-white/28">Forest type</span>
              <select
                className="text-input h-7 text-[9px]"
                value={snapshot.forestPreset}
                onChange={(event) => store.patch({
                  forestPreset: event.target.value as ForestPresetId,
                })}
              >
                {FOREST_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.label}</option>
                ))}
              </select>
            </label>
            <p className="min-h-7 text-[8px] leading-relaxed text-white/28">
              {forestPreset.description}
            </p>
            <ForestOptionRow label="Density">
              {[
                { value: 0.65, label: 'Open' },
                { value: 1, label: 'Natural' },
                { value: 1.4, label: 'Dense' },
              ].map((option) => (
                <ForestOptionButton
                  key={option.value}
                  label={option.label}
                  active={snapshot.forestDensity === option.value}
                  onClick={() => store.patch({ forestDensity: option.value })}
                />
              ))}
            </ForestOptionRow>
            <ForestOptionRow label="Area radius">
              {[
                { value: 45, label: '45 m' },
                { value: 90, label: '90 m' },
                { value: 140, label: '140 m' },
                { value: 190, label: '190 m' },
              ].map((option) => (
                <ForestOptionButton
                  key={option.value}
                  label={option.label}
                  active={snapshot.forestRadius === option.value}
                  onClick={() => store.patch({ forestRadius: option.value })}
                />
              ))}
            </ForestOptionRow>
            <label className="flex items-center gap-2">
              <span className="text-[8px] uppercase tracking-[0.12em] text-white/28">Seed</span>
              <input
                className="text-input h-7 min-w-0 flex-1 font-mono text-[9px]"
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
                <Sprout size={11} /> Generate forest
              </button>
              <button
                type="button"
                title="Generate a different forest seed"
                aria-label="Shuffle forest"
                className="icon-button size-8 border border-white/[0.07]"
                onClick={() => store.randomizeForest()}
              >
                <Shuffle size={11} />
              </button>
            </div>
            <p className="text-[7px] leading-relaxed text-white/20">
              Replaces the current layout. Tree geometry is compiled once per variation and instanced across the forest.
            </p>
          </div>
        </section>
        <div className="mb-1 flex items-center gap-2 px-1 py-1.5 text-[8px] uppercase tracking-[0.13em] text-white/24">
          <span className="h-px flex-1 bg-white/[0.055]" /> Individual trees <span className="h-px flex-1 bg-white/[0.055]" />
        </div>
        {species.map((definition, speciesIndex) => {
          const count = snapshot.placements.filter(
            (placement) => snapshot.prototypes[placement.prototypeId]?.species === definition.id,
          ).length
          return (
            <details
              key={definition.id}
              open={speciesIndex < 3 || Boolean(search) ? true : undefined}
              className="group mb-1 overflow-hidden rounded-md border border-white/[0.055] bg-black/10"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-[10px] text-white/58 transition hover:bg-white/[0.025] hover:text-white/78">
                <span className="size-1.5 rounded-full bg-[#77e8be]/45" />
                <span className="flex-1">{definition.label}</span>
                {count > 0 && <span className="font-mono text-[8px] text-[#a6f2d5]/55">{count} placed</span>}
                <span className="text-[8px] uppercase tracking-wider text-white/22">{definition.group.replaceAll('-', ' ')}</span>
              </summary>
              <div className="grid grid-cols-2 gap-1 border-t border-white/[0.045] p-1.5">
                {TREE_VARIATION_NAMES.map((name, variation) => {
                  const id = treePrototypeId(definition.id, variation)
                  const prototype = snapshot.prototypes[id]
                  const placed = snapshot.placements.filter(
                    (placement) => placement.prototypeId === id,
                  ).length
                  return (
                    <button
                      key={id}
                      type="button"
                      title={`${name}: distinct deterministic topology`}
                      data-active={snapshot.armedPrototypeId === id}
                      className="group/variant relative min-h-11 rounded border border-white/[0.055] bg-white/[0.018] px-2 py-1.5 text-left transition hover:border-[#77e8be]/20 hover:bg-[#77e8be]/[0.045] data-[active=true]:border-[#77e8be]/35 data-[active=true]:bg-[#77e8be]/10"
                      onClick={() => store.armPlacement(definition.id as TreeSpecies, variation)}
                    >
                      <span className="block truncate text-[9px] text-white/55 group-hover/variant:text-white/78">{name}</span>
                      <span className="mt-1 flex items-center justify-between font-mono text-[7px] uppercase tracking-wide text-white/20">
                        v{variation + 1}
                        {prototype?.building ? 'building' : placed ? `${placed}×` : 'place'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </details>
          )
        })}
      </div>
    </aside>
  )
}

function ForestOptionRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1">
      <span className="text-[8px] uppercase tracking-[0.12em] text-white/28">{label}</span>
      <div className="grid grid-cols-3 gap-1">{children}</div>
    </div>
  )
}

function ForestOptionButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-active={active}
      className="rounded border border-white/[0.055] bg-black/10 px-1 py-1 text-[8px] text-white/35 transition hover:text-white/65 data-[active=true]:border-[#77e8be]/25 data-[active=true]:bg-[#77e8be]/10 data-[active=true]:text-[#b7f6df]/80"
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function TreeInspector({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  const prototype = selectedTreePrototype(snapshot)
  if (!prototype) return null
  const parameters = prototype.parameters
  const instances = snapshot.placements.filter(
    (placement) => placement.prototypeId === prototype.id,
  ).length
  const lod = prototype.asset?.lods[snapshot.lod]

  return (
    <aside
      aria-label="Selected tree inspector"
      className="pointer-events-auto absolute bottom-12 right-3 top-[94px] z-20 w-[280px] overflow-y-auto rounded-lg border border-white/[0.09] bg-[#0b1312]/94 shadow-2xl shadow-black/30 backdrop-blur-xl"
    >
      <Section icon={Sprout} title={prototype.variationName} badge={`${instances}× shared`}>
        <div>
          <p className="text-[12px] font-medium capitalize text-white/78">{prototype.species.replaceAll('-', ' ')}</p>
          <p className="mt-1 text-[9px] leading-relaxed text-white/30">
            Changes compile once and replace every instance of this catalogue variation.
          </p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-[9px] uppercase tracking-[0.12em] text-white/30">Topology seed</span>
          <input
            className="text-input font-mono"
            type="number"
            min={1}
            max={0x7fffffff}
            value={parameters.seed}
            onChange={(event) => store.patchSelectedParameters({ seed: Number(event.target.value) })}
          />
        </label>
        <RangeField label="Height" value={parameters.height} min={4} max={120} step={0.5} unit=" m" onChange={(height) => store.patchSelectedParameters({ height })} />
        <RangeField label="Crown spread" value={parameters.crownRadius} min={1.5} max={35} step={0.25} unit=" m" onChange={(crownRadius) => store.patchSelectedParameters({ crownRadius })} />
        <RangeField label="Trunk radius" value={parameters.trunkRadius} min={0.12} max={8} step={0.05} unit=" m" onChange={(trunkRadius) => store.patchSelectedParameters({ trunkRadius })} />
        <RangeField label="Maturity" value={parameters.age} min={0} max={1} step={0.01} onChange={(age) => store.patchSelectedParameters({ age })} />
        <RangeField label="Gnarl" value={parameters.gnarl} min={0} max={1} step={0.01} onChange={(gnarl) => store.patchSelectedParameters({ gnarl })} />
        <RangeField label="Foliage" value={parameters.foliageDensity} min={0} max={MAX_FOLIAGE_DENSITY} step={0.01} onChange={(foliageDensity) => store.patchSelectedParameters({ foliageDensity })} />
      </Section>
      <Section icon={GitBranch} title="Architecture">
        <Segmented ariaLabel="Bole plan" value={parameters.bolePlan} options={BOLE_OPTIONS} columns={2} onChange={(bolePlan) => store.patchSelectedParameters({ bolePlan })} />
        <Segmented ariaLabel="Crown form" value={parameters.crownForm} options={CROWN_OPTIONS} columns={2} onChange={(crownForm) => store.patchSelectedParameters({ crownForm })} />
        <RangeField label="Lean" value={parameters.lean} min={0} max={35} step={0.5} unit="°" onChange={(lean) => store.patchSelectedParameters({ lean })} />
        <RangeField label="Sinuosity" value={parameters.sinuosity} min={0} max={3} step={0.05} onChange={(sinuosity) => store.patchSelectedParameters({ sinuosity })} />
        <RangeField label="Major branches" value={parameters.branchCount} min={5} max={30} step={1} onChange={(branchCount) => store.patchSelectedParameters({ branchCount })} />
      </Section>
      <div className="space-y-2 p-3">
        <button
          type="button"
          className="panel-button w-full"
          data-accent="mint"
          disabled={prototype.building}
          onClick={() => store.recompileSelected()}
        >
          <RefreshCw size={12} className={prototype.building ? 'animate-spin' : ''} />
          {prototype.building ? 'Compiling shared tree…' : prototype.dirty ? `Apply to ${instances} trees` : 'Recompile shared tree'}
        </button>
        {(prototype.building || prototype.warmingMaterials) && (
          <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-[#77e8be]/70 transition-[width]" style={{ width: `${Math.max(3, prototype.buildProgress * 100)}%` }} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-1.5 text-[9px]">
          <Metric label="Triangles" value={lod ? compact(lod.wood.indices.length / 3) : '—'} />
          <Metric label="Leaves" value={lod ? compact(lod.foliage.count) : '—'} />
        </div>
        <p className="text-[9px] leading-relaxed text-white/30">{prototype.status}</p>
      </div>
    </aside>
  )
}

function TreeRenderControls({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  return (
    <div className="pointer-events-auto absolute bottom-2 left-1/2 z-20 flex h-9 -translate-x-1/2 items-center gap-2 rounded-lg border border-white/[0.09] bg-[#0b1312]/92 px-2 shadow-2xl backdrop-blur-xl">
      <Gauge size={11} className="text-white/28" />
      <Pills
        value={snapshot.lod.toString()}
        options={[
          { value: '0', label: 'Auto', title: 'Distance-based hero, mid, and far LODs' },
          { value: '1', label: 'Mid+', title: 'Distance LOD with hero detail disabled except selection' },
          { value: '2', label: 'Far', title: 'Force far LOD except for the selected tree' },
        ]}
        onChange={(value) => store.patch({ lod: Number(value) as TreeLodLevel })}
      />
      <Divider />
      <Pills
        value={snapshot.debugMode}
        options={DEBUG_OPTIONS.map((option) => ({ value: option.value, label: option.short, title: option.label }))}
        onChange={(debugMode) => store.patch({ debugMode })}
      />
      <Divider />
      <button
        type="button"
        title="Toggle foliage"
        aria-pressed={snapshot.showFoliage}
        data-active={snapshot.showFoliage}
        className="quick-pill flex items-center gap-1"
        onClick={() => store.patch({ showFoliage: !snapshot.showFoliage })}
      >
        <Leaf size={10} /> leaf
      </button>
    </div>
  )
}

function TreeDiagnostics({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  const active = Object.values(snapshot.prototypes).filter((prototype) => prototype.building)
  const selected = selectedTreePrototype(snapshot)
  return (
    <div className="pointer-events-auto absolute right-3 top-[46px] z-20 flex h-9 items-center gap-2 rounded-lg border border-white/[0.09] bg-[#0b1312]/92 px-2 shadow-xl backdrop-blur-xl">
      <span className={`size-1.5 rounded-full ${active.length ? 'animate-pulse bg-amber-300' : 'bg-[#77e8be]'}`} />
      <span className="max-w-40 truncate text-[9px] text-white/38">{active.length ? `${active.length} compiling` : selected?.status ?? snapshot.status}</span>
      <span className="h-4 w-px bg-white/[0.08]" />
      <span className="font-mono text-[9px] text-white/42">{snapshot.placements.length} trees</span>
      <button
        type="button"
        title="Performance overlay"
        aria-pressed={snapshot.showHud}
        data-active={snapshot.showHud}
        className="icon-button size-6"
        onClick={() => store.patch({ showHud: !snapshot.showHud })}
      >
        <Activity size={11} />
      </button>
    </div>
  )
}

function TreePerformanceOverlay({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  const prototypes = Object.values(snapshot.prototypes)
  const compiled = prototypes.filter((prototype) => prototype.asset)
  const triangles = compiled.reduce((sum, prototype) => {
    const instances = snapshot.placements.filter((placement) => placement.prototypeId === prototype.id).length
    return sum + (prototype.asset?.lods[snapshot.lod].wood.indices.length ?? 0) / 3 * instances
  }, 0)
  const uniqueTriangles = compiled.reduce(
    (sum, prototype) => sum + (prototype.asset?.lods[snapshot.lod].wood.indices.length ?? 0) / 3,
    0,
  )
  return (
    <section className="pointer-events-none absolute right-[304px] top-[94px] z-30 w-[260px] overflow-hidden rounded-lg border border-white/[0.09] bg-[#08110f]/92 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2 text-[10px] text-white/55">
        <span className="flex items-center gap-2"><Activity size={11} /> Forest performance</span>
        <span className="font-mono text-[#77e8be]">{compiled.length}/{prototypes.length}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 p-3">
        <HudMetric label="Placed trees" value={compact(snapshot.placements.length)} />
        <HudMetric label="Draw prototypes" value={compact(compiled.length)} />
        <HudMetric label="Scene triangles" value={compact(triangles)} />
        <HudMetric label="Unique geometry" value={compact(uniqueTriangles)} />
      </div>
      <p className="border-t border-white/[0.07] px-3 py-2 text-[8px] leading-relaxed text-white/25">
        Matching trees share compiled geometry, materials, textures, and instanced draw batches.
      </p>
    </section>
  )
}

function ToolButton({ icon: Icon, label, active, danger, disabled, onClick }: {
  icon: LucideIcon
  label: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} data-active={active} data-danger={danger} disabled={disabled} className="bar-button" onClick={onClick}>
      <Icon size={14} strokeWidth={1.7} />
    </button>
  )
}

function TreeEditorShortcuts({ store }: { store: TreeEditorStore }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'Escape') {
        store.cancelPlacement()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        store.deleteSelected()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        store.duplicateSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [store])
  return null
}

function Pills<Value extends string>({ value, options, onChange }: {
  value: Value
  options: { value: Value; label: string; title?: string }[]
  onChange: (value: Value) => void
}) {
  return (
    <div className="flex items-center gap-0.5">
      {options.map((option) => (
        <button key={option.value} type="button" title={option.title ?? option.label} data-active={option.value === value} className="quick-pill" onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Divider() { return <span className="mx-0.5 h-4 w-px bg-white/[0.09]" /> }

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded border border-white/[0.05] bg-black/10 p-2"><span className="block text-white/28">{label}</span><span className="mt-1 block font-mono text-white/62">{value}</span></div>
}

function HudMetric({ label, value }: { label: string; value: string }) {
  return <div><span className="block text-[8px] uppercase tracking-wide text-white/25">{label}</span><span className="mt-1 block font-mono text-[11px] text-white/68">{value}</span></div>
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Math.round(value).toString()
}
