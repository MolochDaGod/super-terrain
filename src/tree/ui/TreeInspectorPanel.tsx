import { Brush, GitBranch, Info, Sprout, Wind } from 'lucide-react'
import { RangeField } from '../../components/editor/RangeField'
import { Section } from '../../components/editor/ui/Section'
import { Segmented } from '../../components/editor/ui/Segmented'
import { EmptyHint } from '../../components/editor/ui/EmptyHint'
import type { FoliageEditorStore } from '../../foliage/FoliageEditorStore'
import { useFoliageSnapshot } from '../../foliage/react/useFoliageSnapshot'
import {
  MAX_FOLIAGE_DENSITY,
  type TreeBolePlan,
  type TreeCrownForm,
} from '../generator/types'
import { selectedTreePrototype, type TreeEditorStore } from '../TreeEditorStore'
import { useTreeEditorSnapshot } from '../useTreeEditorSnapshot'
import { TREE_TOOL_BY_ID, activeTreeTool } from './treeTools'

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

/**
 * The numbers of the one thing being worked on.
 *
 * Tool parameters at the top, because they change what the next drag does, and
 * the selection below them. Same order and the same two zones as the terrain
 * editor's inspector — which is the point: the two workspaces should not have
 * to be learned separately.
 */
export function TreeInspectorPanel({
  store,
  foliage,
}: {
  store: TreeEditorStore
  foliage: FoliageEditorStore
}) {
  const snapshot = useTreeEditorSnapshot(store)
  const floor = useFoliageSnapshot(foliage)
  const tool = TREE_TOOL_BY_ID[activeTreeTool(snapshot, floor)]
  const brush = tool.id === 'grow' || tool.id === 'clear'
  const prototype = selectedTreePrototype(snapshot)

  return (
    <aside
      aria-label="Inspector"
      className="pointer-events-auto absolute bottom-7 right-3 top-[46px] z-20 hidden w-[268px] overflow-y-auto rounded-lg border border-white/[0.09] bg-[#0b1312]/92 shadow-2xl shadow-black/30 backdrop-blur-xl lg:block"
    >
      <Section icon={tool.icon} title={tool.label}>
        {brush ? (
          <>
            <RangeField
              label="Size"
              value={floor.radius}
              min={0.5}
              max={60}
              step={0.5}
              unit=" m"
              onChange={(radius) => foliage.patch({ radius })}
            />
            <RangeField
              label="Flow"
              hint="weight per second"
              value={floor.flow}
              min={0.05}
              max={1}
              step={0.05}
              onChange={(flow) => foliage.patch({ flow })}
            />
            <RangeField
              label="Edge"
              hint={floor.hardness < 0.2 ? 'feathered' : 'hard'}
              value={floor.hardness}
              min={0}
              max={0.95}
              step={0.05}
              onChange={(hardness) => foliage.patch({ hardness })}
            />
            <RangeField
              label="Abundance"
              hint="clumps placed"
              value={floor.density}
              min={0.05}
              max={1}
              step={0.05}
              onChange={(density) => foliage.patch({ density })}
            />
          </>
        ) : tool.id === 'place' ? (
          <p className="text-[11px] leading-relaxed text-white/38">
            {snapshot.armedPrototypeId
              ? `${snapshot.prototypes[snapshot.armedPrototypeId]?.variationName ?? 'Variation'} armed. Click the ground to plant it.`
              : 'Pick a variation in the catalogue on the left, then click the ground.'}
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-white/38">
            Click a tree to select it. Editing its parameters recompiles every
            tree that shares the variation.
          </p>
        )}
      </Section>


      {brush && (
      <Section icon={Wind} title="Wind">
        <RangeField
          label="Strength"
          value={floor.wind.strength}
          min={0}
          max={1.4}
          step={0.05}
          onChange={(strength) => foliage.patchWind({ strength })}
        />
        <RangeField
          label="Gust size"
          value={floor.wind.gustScale}
          min={3}
          max={60}
          step={1}
          unit=" m"
          onChange={(gustScale) => foliage.patchWind({ gustScale })}
        />
        <RangeField
          label="Gust speed"
          value={floor.wind.gustSpeed}
          min={0}
          max={4}
          step={0.05}
          onChange={(gustSpeed) => foliage.patchWind({ gustSpeed })}
        />
        <RangeField
          label="Heading"
          value={floor.wind.heading}
          min={0}
          max={6.28}
          step={0.05}
          unit=" rad"
          onChange={(heading) => foliage.patchWind({ heading })}
        />
      </Section>
      )}

      {prototype ? (
        <TreePrototypeSections store={store} />
      ) : (
        <Section icon={Info} title="Selection">
          <EmptyHint>
            No tree selected. Click one in the viewport to edit the prototype it
            shares with every matching stem.
          </EmptyHint>
        </Section>
      )}
    </aside>
  )
}

function TreePrototypeSections({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  const prototype = selectedTreePrototype(snapshot)
  if (!prototype) return null
  const parameters = prototype.parameters
  const instances = snapshot.placements.filter(
    (placement) => placement.prototypeId === prototype.id,
  ).length
  const lod = prototype.asset?.lods[snapshot.lod]

  return (
    <>
      <Section
        icon={Sprout}
        title={prototype.variationName}
        badge={`${instances}× shared`}
      >
        <p className="text-[12px] font-medium capitalize text-white/78">
          {prototype.species.replaceAll('-', ' ')}
        </p>
        <label className="block space-y-1.5">
          <span className="text-[10px] uppercase tracking-[0.12em] text-white/30">
            Topology seed
          </span>
          <input
            className="text-input font-mono"
            type="number"
            min={1}
            max={0x7fffffff}
            value={parameters.seed}
            onChange={(event) =>
              store.patchSelectedParameters({ seed: Number(event.target.value) })
            }
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
          className="panel-button w-full justify-center"
          data-accent="mint"
          disabled={prototype.building}
          onClick={() => store.recompileSelected()}
        >
          <Brush size={12} className={prototype.building ? 'animate-spin' : ''} />
          {prototype.building
            ? 'Compiling…'
            : prototype.dirty
              ? `Apply to ${instances} trees`
              : 'Recompile'}
        </button>
        {(prototype.building || prototype.warmingMaterials) && (
          <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-[#77e8be]/70 transition-[width]"
              style={{ width: `${Math.max(3, prototype.buildProgress * 100)}%` }}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-1.5 text-[10px]">
          <Metric label="Triangles" value={lod ? compact(lod.wood.indices.length / 3) : '—'} />
          <Metric label="Leaves" value={lod ? compact(lod.foliage.count) : '—'} />
        </div>
        <p className="text-[10px] leading-relaxed text-white/30">{prototype.status}</p>
      </div>
    </>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-white/[0.05] bg-black/10 p-2">
      <span className="block text-white/28">{label}</span>
      <span className="mt-1 block font-mono text-white/62">{value}</span>
    </div>
  )
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Math.round(value).toString()
}
