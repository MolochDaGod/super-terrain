import { useEffect, useRef } from 'react'
import { Activity, Box, Cpu, Layers, Play, SlidersHorizontal } from 'lucide-react'
import type { BenchmarkScenario, WorldTerrain } from '../../terrain/WorldTerrain'
import type {
  EditorStore,
  TerrainOverlay,
} from '../../terrain/editor/EditorStore'
import { useEditorSnapshot, useTerrainMetrics } from '../../terrain/react/hooks'
import { RangeField } from './RangeField'
import { ModifierStackPanel } from './ModifierStackPanel'
import { SculptLayersPanel } from './SculptLayersPanel'
import { MaterialChannelsPanel } from './MaterialChannelsPanel'
import { CsgObjectsPanel } from './CsgObjectsPanel'
import { GraniteRockPanel } from './GraniteRockPanel'

interface InspectorPanelProps {
  terrain: WorldTerrain
  editor: EditorStore
}

const OVERLAYS: { id: TerrainOverlay; label: string }[] = [
  { id: 'none', label: 'Clean' },
  { id: 'sections', label: 'Sections' },
  { id: 'lod', label: 'LOD' },
  { id: 'density', label: 'Density' },
  { id: 'streaming', label: 'Stream' },
]

export function InspectorPanel({ terrain, editor }: InspectorPanelProps) {
  const snapshot = useEditorSnapshot(editor)
  const metrics = useTerrainMetrics(terrain)
  const previousBenchmark = useRef(metrics.activeBenchmark)
  const isSculptTool =
    snapshot.tool === 'raise' ||
    snapshot.tool === 'lower' ||
    snapshot.tool === 'smooth' ||
    snapshot.tool === 'flatten' ||
    snapshot.tool === 'clay' ||
    snapshot.tool === 'pinch' ||
    snapshot.tool === 'scrape' ||
    snapshot.tool === 'terrace' ||
    snapshot.tool === 'noise'
  const isPaintTool = snapshot.tool === 'paint'

  useEffect(() => {
    if (previousBenchmark.current && !metrics.activeBenchmark) {
      editor.patch({ status: 'Stress scenario complete · stream scheduler online' })
    }
    previousBenchmark.current = metrics.activeBenchmark
  }, [editor, metrics.activeBenchmark])
  const selectOverlay = (overlay: TerrainOverlay) => {
    editor.patch({ overlay })
    terrain.setOverlay(overlay)
  }

  return (
    <aside className="pointer-events-auto absolute bottom-9 right-3 top-[68px] z-20 hidden w-[268px] overflow-y-auto rounded-xl border border-white/[0.09] bg-[#0b1312]/92 shadow-2xl shadow-black/30 backdrop-blur-xl md:block">
      <PanelHeader icon={SlidersHorizontal} title="Tool parameters" />
      <div className="space-y-5 border-b border-white/[0.07] px-4 py-4">
        <ToolReadout tool={snapshot.tool} domain={snapshot.brushDomain} />
        {isSculptTool && (
          <BrushDomainSwitch
            value={snapshot.brushDomain}
            onChange={(brushDomain) =>
              editor.patch({
                brushDomain,
                status:
                  brushDomain === 'mesh'
                    ? 'Mesh Terrain brush · surface-normal XYZ deformation'
                    : 'Heightfield brush · world-Y deformation',
              })
            }
          />
        )}
        {(isSculptTool || isPaintTool || snapshot.tool === 'remesh') && (
          <RangeField
            label={snapshot.tool === 'remesh' ? 'Influence radius' : 'Brush radius'}
            value={snapshot.brushRadius}
            min={4}
            max={72}
            step={1}
            unit=" m"
            onChange={(brushRadius) => editor.patch({ brushRadius })}
          />
        )}
        {(isSculptTool || isPaintTool) && (
          <>
            <RangeField
              label="Strength"
              value={snapshot.brushStrength}
              min={0.03}
              max={1}
              step={0.01}
              onChange={(brushStrength) => editor.patch({ brushStrength })}
            />
            <RangeField
              label="Falloff"
              value={snapshot.brushFalloff}
              min={0}
              max={1}
              step={0.01}
              onChange={(brushFalloff) => editor.patch({ brushFalloff })}
            />
          </>
        )}
        {snapshot.tool === 'terrace' && (
          <RangeField
            label="Terrace height"
            value={snapshot.terraceStep}
            min={0.5}
            max={16}
            step={0.5}
            unit=" m"
            onChange={(terraceStep) => editor.patch({ terraceStep })}
          />
        )}
        {snapshot.tool === 'noise' && (
          <RangeField
            label="Noise scale"
            value={snapshot.noiseScale}
            min={0.25}
            max={24}
            step={0.25}
            unit=" m"
            onChange={(noiseScale) => editor.patch({ noiseScale })}
          />
        )}
        {isPaintTool && (
          <div>
            <div className="mb-2 text-[9px] font-medium uppercase tracking-[0.12em] text-white/30">
              Paint mode
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/[0.07] bg-black/10 p-1">
              {(['add', 'subtract'] as const).map((paintMode) => (
                <button
                  key={paintMode}
                  type="button"
                  data-active={snapshot.paintMode === paintMode}
                  className="rounded-md px-2 py-2 text-[9px] capitalize transition"
                  onClick={() => editor.patch({ paintMode })}
                >
                  {paintMode}
                </button>
              ))}
            </div>
          </div>
        )}
        {snapshot.tool === 'remesh' && (
          <RangeField
            label="Target edge"
            value={snapshot.targetEdgeLength}
            min={0.75}
            max={12}
            step={0.25}
            unit=" m"
            onChange={(targetEdgeLength) => editor.patch({ targetEdgeLength })}
          />
        )}
        {snapshot.tool === 'tunnel' && (
          <>
            <RangeField
              label="Portal radius"
              value={snapshot.tunnelRadius}
              min={2}
              max={24}
              step={0.5}
              unit=" m"
              onChange={(tunnelRadius) => editor.patch({ tunnelRadius })}
            />
            <RangeField
              label="Burial depth"
              value={snapshot.tunnelDepth}
              min={3}
              max={48}
              step={1}
              unit=" m"
              onChange={(tunnelDepth) => editor.patch({ tunnelDepth })}
            />
          </>
        )}
      </div>

      <SculptLayersPanel terrain={terrain} editor={editor} />
      <MaterialChannelsPanel terrain={terrain} editor={editor} />
      <GraniteRockPanel terrain={terrain} editor={editor} />
      <CsgObjectsPanel terrain={terrain} editor={editor} />
      <ModifierStackPanel terrain={terrain} editor={editor} />

      <PanelHeader icon={Layers} title="Visualization" />
      <div className="grid grid-cols-3 gap-1 border-b border-white/[0.07] px-3.5 pb-4">
        {OVERLAYS.map((overlay) => (
          <button
            key={overlay.id}
            type="button"
            className="rounded-md border px-1.5 py-1.5 text-[9px] transition"
            data-active={snapshot.overlay === overlay.id}
            onClick={() => selectOverlay(overlay.id)}
          >
            {overlay.label}
          </button>
        ))}
      </div>

      <PanelHeader icon={Cpu} title="Async compiler" />
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-white/[0.07] px-4 pb-4">
        <MiniStat label="Active" value={metrics.workerActiveJobs} accent />
        <MiniStat label="Queued" value={metrics.workerQueuedJobs} />
        <MiniStat label="P50 compile" value={`${metrics.compileP50Ms.toFixed(1)} ms`} />
        <MiniStat label="P95 compile" value={`${metrics.compileP95Ms.toFixed(1)} ms`} />
      </div>

      <PanelHeader icon={Activity} title="Stress scenarios" />
      <div className="space-y-2 px-3.5 pb-4">
        <BenchmarkButton
          label="Sculpt torture"
          detail="Rapid edits across neighboring sections"
          active={metrics.activeBenchmark === 'sculpt-torture'}
          onClick={() => runBenchmark(terrain, editor, 'sculpt-torture')}
        />
        <BenchmarkButton
          label="Rebuild torture"
          detail="Coalescing, cancellation, atomic swaps"
          active={metrics.activeBenchmark === 'rebuild-torture'}
          onClick={() => runBenchmark(terrain, editor, 'rebuild-torture')}
        />
        <BenchmarkButton
          label="Streaming torture"
          detail="Extreme fly-through and LRU pressure"
          active={metrics.activeBenchmark === 'streaming-torture'}
          onClick={() => runBenchmark(terrain, editor, 'streaming-torture')}
        />
      </div>

      <div className="mx-3.5 mb-3.5 flex items-start gap-2.5 rounded-lg border border-[#77e8be]/10 bg-[#77e8be]/[0.045] p-3">
        <Box size={14} className="mt-0.5 shrink-0 text-[#77e8be]/70" />
        <p className="text-[9px] leading-relaxed text-white/38">
          Old compiled meshes stay visible until worker results pass revision checks and fit the frame budget.
        </p>
      </div>
    </aside>
  )
}

function PanelHeader({ icon: Icon, title }: { icon: typeof Activity; title: string }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-3 pt-4 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/35">
      <Icon size={12} strokeWidth={1.7} />
      <span>{title}</span>
    </div>
  )
}

function ToolReadout({
  tool,
  domain,
}: {
  tool: string
  domain: 'heightfield' | 'mesh'
}) {
  const descriptions: Record<string, string> = {
    select: 'Inspect sections without modifying source data.',
    raise:
      domain === 'mesh'
        ? 'Push the picked mesh surface outward along its local normal.'
        : 'Raise the procedural surface along world Y.',
    lower:
      domain === 'mesh'
        ? 'Pull the picked mesh surface inward along its local normal.'
        : 'Lower the procedural surface along world Y.',
    smooth: 'Relax local detail toward the broad terrain field.',
    flatten: 'Converge the surface toward the first sampled elevation.',
    clay: 'Build broad clay-like mass with a naturally flattened crest.',
    pinch: 'Pull the surface inward in the tangent plane to sharpen ridges and creases.',
    scrape: 'Plane away only material above the sampled surface.',
    terrace: 'Quantize elevation into editable stepped benches.',
    noise: 'Stamp seeded surface breakup at a configurable world scale.',
    paint: 'Paint or erase one of four configurable material weight channels.',
    remesh: 'Inject local coordinate bands at the requested edge length.',
    tunnel: 'Press one portal, drag to the second, then release. The swept Boolean remains editable in the modifier stack.',
  }
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-3">
      <div className="mb-1 text-[10px] font-medium capitalize text-white/78">{tool}</div>
      <p className="text-[9px] leading-relaxed text-white/36">{descriptions[tool]}</p>
    </div>
  )
}

function BrushDomainSwitch({
  value,
  onChange,
}: {
  value: 'heightfield' | 'mesh'
  onChange: (value: 'heightfield' | 'mesh') => void
}) {
  return (
    <div>
      <div className="mb-2 text-[9px] font-medium uppercase tracking-[0.12em] text-white/30">
        Brush domain
      </div>
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/[0.07] bg-black/10 p-1">
        <button
          type="button"
          data-active={value === 'heightfield'}
          className="rounded-md px-2 py-2 text-[9px] transition"
          onClick={() => onChange('heightfield')}
        >
          Heightfield · Y
        </button>
        <button
          type="button"
          data-active={value === 'mesh'}
          className="rounded-md px-2 py-2 text-[9px] transition"
          onClick={() => onChange('mesh')}
        >
          Mesh · XYZ
        </button>
      </div>
    </div>
  )
}

function MiniStat({
  label,
  value,
  accent = false,
}: {
  label: string
  value: string | number
  accent?: boolean
}) {
  return (
    <div>
      <div className="text-[9px] text-white/30">{label}</div>
      <div
        className={`mt-0.5 font-mono text-[11px] tabular-nums ${accent ? 'text-[#65e8ff]' : 'text-white/68'}`}
      >
        {value}
      </div>
    </div>
  )
}

function BenchmarkButton({
  label,
  detail,
  active,
  onClick,
}: {
  label: string
  detail: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.025] p-2.5 text-left transition hover:border-white/[0.14] hover:bg-white/[0.045]"
      onClick={onClick}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white/[0.05] text-white/46 group-hover:text-[#b7f6df]">
        <Play size={12} fill="currentColor" />
      </span>
      <span className="min-w-0">
        <span className="block text-[10px] text-white/70">{active ? 'Running…' : label}</span>
        <span className="mt-0.5 block truncate text-[8px] text-white/28">{detail}</span>
      </span>
    </button>
  )
}

function runBenchmark(
  terrain: WorldTerrain,
  editor: EditorStore,
  name: BenchmarkScenario,
): void {
  terrain.startBenchmark(name)
  editor.patch({ status: `${name.replace('-', ' ')} running for seven seconds` })
}
