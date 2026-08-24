import { useState } from 'react'
import {
  Activity,
  Box,
  Braces,
  Boxes,
  CircleDot,
  Download,
  Eye,
  GitBranch,
  Layers3,
  Leaf,
  Network,
  RefreshCw,
  Save,
  ScanLine,
  Shuffle,
  SlidersHorizontal,
  Sprout,
  TreePine,
  Waypoints,
} from 'lucide-react'
import { RangeField } from '../components/editor/RangeField'
import { Section } from '../components/editor/ui/Section'
import { Segmented } from '../components/editor/ui/Segmented'
import { downloadTreeGlb } from './exportTreeGlb'
import {
  type TreeBoleForm,
  type TreeCrownForm,
  type TreeLodLevel,
  type TreeRootForm,
  type TreeSpecies,
} from './generator/types'
import type { TreeDebugMode, TreeEditorStore } from './TreeEditorStore'
import { saveTreeToLibrary } from './treePersistence'
import { useTreeEditorSnapshot } from './useTreeEditorSnapshot'

const SPECIES_OPTIONS = [
  { value: 'ancient-oak', label: 'Ancient oak' },
  { value: 'field-oak', label: 'Field oak' },
  { value: 'windswept-pine', label: 'Pine' },
] satisfies { value: TreeSpecies; label: string }[]

// Structural forms, not style presets: each picks a different growth history
// and therefore a different skeleton. `Auto` hands the choice to the seed,
// which is what a whole stand wants; naming one pins this individual, which is
// what authoring a specific hero tree wants.
const BOLE_FORM_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'straight', label: 'Straight' },
  { value: 'leaning', label: 'Leaning' },
  { value: 'sinuous', label: 'Sinuous' },
  { value: 'codominant', label: 'Twin stem' },
  { value: 'snapped', label: 'Broken top' },
] satisfies { value: TreeBoleForm; label: string }[]

const CROWN_FORM_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'full', label: 'Full' },
  { value: 'lopsided', label: 'Lopsided' },
  { value: 'stagheaded', label: 'Stag head' },
  { value: 'reiterated', label: 'Rebuilt' },
] satisfies { value: TreeCrownForm; label: string }[]

const ROOT_FORM_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'sunken', label: 'Sunken' },
  { value: 'buttressed', label: 'Buttressed' },
  { value: 'braided', label: 'Braided' },
  { value: 'stilted', label: 'Stilted' },
] satisfies { value: TreeRootForm; label: string }[]

const DEBUG_OPTIONS = [
  { value: 'surface', label: 'Surface', icon: Eye },
  { value: 'skeleton', label: 'Skeleton', icon: GitBranch },
  { value: 'hierarchy', label: 'Hierarchy', icon: Network },
  { value: 'continuations', label: 'Flow', icon: Activity },
  { value: 'radii', label: 'Radii', icon: CircleDot },
  { value: 'contacts', label: 'Contacts', icon: ScanLine },
  { value: 'burial', label: 'Burial', icon: Layers3 },
  { value: 'topology', label: 'Topology', icon: Boxes },
] satisfies { value: TreeDebugMode; label: string; icon: typeof Eye }[]

export function TreeWorkspacePanels({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  const { parameters, asset } = snapshot
  const [exporting, setExporting] = useState(false)
  const lod = asset?.lods[snapshot.lod]

  const exportGlb = async () => {
    if (!asset || exporting) return
    setExporting(true)
    store.patch({ status: `Exporting LOD${snapshot.lod} GLB…` })
    try {
      await downloadTreeGlb(asset, snapshot.lod)
      store.patch({ status: `LOD${snapshot.lod} GLB exported` })
    } catch (error) {
      store.patch({
        status: `Export failed · ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <aside
        aria-label="Tree recipe"
        className="pointer-events-auto absolute bottom-3 left-3 top-[46px] z-20 w-[258px] overflow-y-auto rounded-lg border border-white/[0.09] bg-[#0b1312]/94 shadow-2xl shadow-black/30 backdrop-blur-xl"
      >
        <Section icon={TreePine} title="Tree architecture" badge={parameters.seed}>
          <Segmented
            ariaLabel="Tree species"
            value={parameters.species}
            options={SPECIES_OPTIONS}
            columns={1}
            onChange={(species) => store.applySpecies(species)}
          />
          <label className="block space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.12em] text-white/35">
              Deterministic seed
            </span>
            <div className="flex gap-1.5">
              <input
                className="text-input font-mono"
                type="number"
                min={1}
                max={0x7fffffff}
                value={parameters.seed}
                onChange={(event) =>
                  store.patchParameters({ seed: Number(event.target.value) })
                }
              />
              <button
                type="button"
                title="Generate a different deterministic seed"
                aria-label="Randomize tree seed"
                className="icon-button h-7 w-7 border border-white/[0.08]"
                onClick={() => store.randomize()}
              >
                <Shuffle size={12} />
              </button>
            </div>
          </label>
          <RangeField
            label="Height"
            value={parameters.height}
            min={10}
            max={45}
            step={0.5}
            unit=" m"
            onChange={(height) => store.patchParameters({ height })}
          />
          <RangeField
            label="Crown spread"
            value={parameters.crownRadius}
            min={3}
            max={20}
            step={0.25}
            unit=" m"
            onChange={(crownRadius) => store.patchParameters({ crownRadius })}
          />
          <RangeField
            label="Trunk radius"
            value={parameters.trunkRadius}
            min={0.3}
            max={2.2}
            step={0.05}
            unit=" m"
            onChange={(trunkRadius) => store.patchParameters({ trunkRadius })}
          />
          <RangeField
            label="Maturity"
            value={parameters.age}
            min={0}
            max={1}
            step={0.01}
            onChange={(age) => store.patchParameters({ age })}
          />
          <RangeField
            label="Gnarl"
            value={parameters.gnarl}
            min={0}
            max={1}
            step={0.01}
            onChange={(gnarl) => store.patchParameters({ gnarl })}
          />
        </Section>

        <Section icon={Waypoints} title="Bole form">
          <Segmented
            ariaLabel="Bole form"
            value={parameters.boleForm}
            options={BOLE_FORM_OPTIONS}
            columns={2}
            onChange={(boleForm) => store.patchParameters({ boleForm })}
          />
          <RangeField
            label="Lean"
            hint="from vertical"
            value={parameters.lean}
            min={0}
            max={35}
            step={0.5}
            unit="°"
            onChange={(lean) => store.patchParameters({ lean })}
          />
          <RangeField
            label="Sinuosity"
            hint="S-curve depth"
            value={parameters.sinuosity}
            min={0}
            max={3}
            step={0.05}
            onChange={(sinuosity) => store.patchParameters({ sinuosity })}
          />
          <RangeField
            label="Spiral grain"
            hint="turns over bole"
            value={parameters.twist}
            min={-2}
            max={2}
            step={0.05}
            onChange={(twist) => store.patchParameters({ twist })}
          />
          <RangeField
            label="Fluting"
            hint="buttress ribs"
            value={parameters.fluting}
            min={0}
            max={1}
            step={0.01}
            onChange={(fluting) => store.patchParameters({ fluting })}
          />
          <RangeField
            label="Lost limbs"
            hint="scars & rebuilds"
            value={parameters.lostLimbs}
            min={0}
            max={8}
            step={1}
            onChange={(lostLimbs) => store.patchParameters({ lostLimbs })}
          />
        </Section>

        <Section icon={Sprout} title="Crown & root form">
          <Segmented
            ariaLabel="Crown form"
            value={parameters.crownForm}
            options={CROWN_FORM_OPTIONS}
            columns={2}
            onChange={(crownForm) => store.patchParameters({ crownForm })}
          />
          <Segmented
            ariaLabel="Root form"
            value={parameters.rootForm}
            options={ROOT_FORM_OPTIONS}
            columns={2}
            onChange={(rootForm) => store.patchParameters({ rootForm })}
          />
          <RangeField
            label="Root relief"
            hint="height above soil"
            value={parameters.rootRelief}
            min={0}
            max={3}
            step={0.05}
            onChange={(rootRelief) => store.patchParameters({ rootRelief })}
          />
          <RangeField
            label="Surfacings"
            hint="times it breaks soil"
            value={parameters.rootSurfacings}
            min={0}
            max={5}
            step={1}
            onChange={(rootSurfacings) => store.patchParameters({ rootSurfacings })}
          />
        </Section>

        <Section icon={GitBranch} title="Structural hierarchy">
          <RangeField
            label="Major branches"
            hint="5–15"
            value={parameters.branchCount}
            min={5}
            max={15}
            step={1}
            onChange={(branchCount) => store.patchParameters({ branchCount })}
          />
          <RangeField
            label="Structural roots"
            hint="first-class"
            value={parameters.rootCount}
            min={5}
            max={10}
            step={1}
            onChange={(rootCount) => store.patchParameters({ rootCount })}
          />
          <RangeField
            label="Root spread"
            value={parameters.rootSpread}
            min={3}
            max={16}
            step={0.25}
            unit=" m"
            onChange={(rootSpread) => store.patchParameters({ rootSpread })}
          />
          <RangeField
            label="Root exposure"
            value={parameters.rootExposure}
            min={0}
            max={1}
            step={0.01}
            onChange={(rootExposure) => store.patchParameters({ rootExposure })}
          />
          <RangeField
            label="Foliage density"
            value={parameters.foliageDensity}
            min={0}
            max={1}
            step={0.01}
            onChange={(foliageDensity) => store.patchParameters({ foliageDensity })}
          />
        </Section>

        <div className="space-y-2 p-3">
          <button
            type="button"
            className="panel-button w-full"
            data-accent="mint"
            disabled={snapshot.building}
            onClick={() => store.regenerate()}
          >
            <RefreshCw size={12} className={snapshot.building ? 'animate-spin' : ''} />
            {snapshot.building
              ? 'Compiling tree…'
              : snapshot.dirty
                ? 'Apply & regenerate'
                : 'Regenerate'}
          </button>
          {snapshot.building && (
            <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-[#77e8be]/70 transition-[width] duration-300"
                style={{ width: `${Math.max(3, snapshot.buildProgress * 100)}%` }}
              />
            </div>
          )}
          <p className="min-h-7 text-[10px] leading-relaxed text-white/35">
            {snapshot.status}
          </p>
        </div>
      </aside>

      <aside
        aria-label="Tree compiler"
        className="pointer-events-auto absolute bottom-3 right-3 top-[46px] z-20 w-[264px] overflow-y-auto rounded-lg border border-white/[0.09] bg-[#0b1312]/94 shadow-2xl shadow-black/30 backdrop-blur-xl"
      >
        <Section icon={SlidersHorizontal} title="Debug viewer">
          <div>
            <span className="mb-1.5 block text-[10px] uppercase tracking-[0.12em] text-white/35">
              Generated representation
            </span>
            <div className="seg grid-cols-3">
              {(['Hero', 'Medium', 'Far'] as const).map((label, level) => (
                <button
                  key={label}
                  type="button"
                  data-active={snapshot.lod === level}
                  aria-pressed={snapshot.lod === level}
                  onClick={() => store.patch({ lod: level as TreeLodLevel })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Segmented
            ariaLabel="Tree debug visualization"
            value={snapshot.debugMode}
            options={DEBUG_OPTIONS}
            columns={2}
            onChange={(debugMode) => store.patch({ debugMode })}
          />
          <button
            type="button"
            data-active={snapshot.showFoliage}
            className="panel-button w-full justify-start"
            onClick={() => store.patch({ showFoliage: !snapshot.showFoliage })}
          >
            <Leaf size={12} />
            Foliage clusters
            <span className="ml-auto font-mono text-[9px] text-white/30">
              {snapshot.showFoliage ? 'ON' : 'OFF'}
            </span>
          </button>
        </Section>

        <Section icon={Braces} title="Semantic graph">
          <Metric label="Structural parts" value={asset?.stats.partCount ?? '—'} />
          <Metric
            label="Continuation links"
            value={asset?.graph.parts.filter((part) => part.continuationChildId).length ?? '—'}
          />
          <Metric label="Contact graph" value={asset?.stats.contactCount ?? '—'} />
          <Metric
            label="Foliage masses"
            value={asset?.stats.foliageClusterCount ?? '—'}
          />
        </Section>

        <Section icon={Box} title="Game topology" badge={lod ? `LOD${snapshot.lod}` : undefined}>
          <Metric
            label="Vertices"
            value={lod ? compact(lod.wood.positions.length / 3) : '—'}
          />
          <Metric
            label="Triangles"
            value={lod ? compact(lod.wood.indices.length / 3) : '—'}
          />
          <Metric
            label="Geometric error"
            value={lod ? `${lod.wood.geometricError.toFixed(3)} m` : '—'}
          />
          <Metric label="Retained parts" value={lod?.includedPartCount ?? '—'} />
          <Metric
            label={lod?.foliage.representation === 'clusters' ? 'Crown clusters' : 'Leaf instances'}
            value={lod ? compact(lod.foliage.count) : '—'}
          />
          <p className="rounded-md border border-[#77e8be]/10 bg-[#77e8be]/[0.035] p-2 text-[9px] leading-relaxed text-[#b7f6df]/55">
            Indexed, closed sweep shells with shared continuation rings. Every LOD
            is compiled directly from the semantic graph—not decimated from LOD0.
          </p>
        </Section>

        <Section icon={Sprout} title="Asset output">
          <button
            type="button"
            className="panel-button w-full"
            disabled={!asset}
            onClick={() => {
              const saved = saveTreeToLibrary(parameters)
              store.patch({ status: `${saved.name} saved to the terrain library` })
            }}
          >
            <Save size={12} />
            Save to tree library
          </button>
          <button
            type="button"
            className="panel-button w-full"
            disabled={!asset || exporting}
            onClick={() => void exportGlb()}
          >
            <Download size={12} />
            {exporting ? 'Building GLB…' : `Export LOD${snapshot.lod} GLB`}
          </button>
          <p className="text-[9px] leading-relaxed text-white/28">
            Library entries store deterministic recipes. GLB exports the selected
            indexed wood LOD plus instanced foliage.
          </p>
        </Section>
      </aside>
    </>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.045] pb-1.5 text-[10px] last:border-0 last:pb-0">
      <span className="text-white/38">{label}</span>
      <span className="font-mono tabular-nums text-white/65">{value}</span>
    </div>
  )
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Math.round(value).toString()
}
