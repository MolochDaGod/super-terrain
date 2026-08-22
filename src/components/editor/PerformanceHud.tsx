import { useEffect, useRef } from 'react'
import {
  Activity,
  AlertTriangle,
  Cpu,
  Gauge,
  HardDrive,
  RefreshCw,
  Triangle,
  Upload,
} from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot, useTerrainMetrics } from '../../terrain/react/hooks'

interface PerformanceHudProps {
  terrain: WorldTerrain
  editor: EditorStore
}

export function PerformanceHud({ terrain, editor }: PerformanceHudProps) {
  const metrics = useTerrainMetrics(terrain)
  const editorSnapshot = useEditorSnapshot(editor)
  const historyRef = useRef<number[]>(Array.from({ length: 36 }, () => 16.67))
  const previousAverageRef = useRef<number | undefined>(undefined)
  if (previousAverageRef.current !== metrics.averageFrameMs) {
    previousAverageRef.current = metrics.averageFrameMs
    historyRef.current.push(metrics.averageFrameMs)
    historyRef.current.shift()
  }

  const previousBenchmark = useRef(metrics.activeBenchmark)
  useEffect(() => {
    if (previousBenchmark.current && !metrics.activeBenchmark) {
      editor.patch({ status: 'Stress scenario complete · stream scheduler online' })
    }
    previousBenchmark.current = metrics.activeBenchmark
  }, [editor, metrics.activeBenchmark])

  if (!editorSnapshot.showHud) return null
  const targetFrameMs = 1000 / terrain.config.targetFps
  const violated = metrics.averageFrameMs > targetFrameMs * 1.08
  return (
    <section
      aria-label="Frame telemetry"
      className="pointer-events-none absolute bottom-9 left-[68px] z-20 hidden w-[286px] overflow-hidden rounded-lg border border-white/[0.09] bg-[#08110f]/90 shadow-2xl shadow-black/25 backdrop-blur-xl lg:block"
    >
      <div className="flex items-center justify-between border-b border-white/[0.07] px-3.5 py-2">
        <div className="flex items-center gap-2 text-[11px] text-white/58">
          <Gauge size={12} />
          Frame telemetry
          {metrics.activeBenchmark && (
            <span className="rounded bg-[#77e8be]/12 px-1.5 py-0.5 font-mono text-[9px] text-[#a6f2d5]">
              {metrics.activeBenchmark.replace('-torture', '')}
            </span>
          )}
        </div>
        <div className={`flex items-center gap-1.5 font-mono text-[9px] ${violated ? 'text-[#ff886f]' : 'text-[#77e8be]'}`}>
          {violated && <AlertTriangle size={10} />}
          {metrics.averageFrameMs.toFixed(2)} ms
        </div>
      </div>

      <div className="flex h-12 items-end gap-px border-b border-white/[0.07] px-3.5 pb-2 pt-2">
        {historyRef.current.map((frame, index) => {
          const height = Math.min(100, Math.max(5, (frame / targetFrameMs) * 100))
          return (
            <span
              key={index}
              className={`min-w-0 flex-1 rounded-t-[1px] ${frame > targetFrameMs * 1.08 ? 'bg-[#ff886f]/70' : 'bg-[#77e8be]/55'}`}
              style={{ height: `${height}%` }}
            />
          )
        })}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 px-3.5 py-3">
        <HudStat
          icon={Cpu}
          label="Terrain CPU"
          value={`${metrics.terrainMainThreadMs.toFixed(2)} ms`}
          sub={`schedule ${metrics.terrainSchedulingMs.toFixed(2)} ms`}
        />
        <HudStat
          icon={Triangle}
          label="Rendered"
          value={compactNumber(metrics.trianglesRendered)}
          sub={`${metrics.visibleSections} visible sections`}
        />
        <HudStat
          icon={HardDrive}
          label="GPU terrain"
          value={formatBytes(metrics.gpuBytes)}
          sub={`${metrics.gpuResidentSections} resident sections`}
        />
        <HudStat
          icon={Cpu}
          label="Worker queue"
          value={`${metrics.workerActiveJobs} / ${metrics.workerQueuedJobs}`}
          sub={`${metrics.cancelledJobs} cancelled · ${metrics.staleJobs} stale`}
        />
        <HudStat
          icon={RefreshCw}
          label="Rebuilds"
          value={`${metrics.sectionsRebuilding} active`}
          sub={`${metrics.sectionsSwapped} section swaps this frame`}
        />
        <HudStat
          icon={Upload}
          label="GPU upload"
          value={formatBytes(metrics.gpuUploadBytes)}
          sub={`${metrics.compiledCpuSections} compiled CPU sections`}
        />
        <HudStat
          icon={HardDrive}
          label="CPU cache"
          value={formatBytes(metrics.cpuBytes)}
          sub={`${metrics.sourceResidentSections} source sections`}
        />
        <HudStat
          icon={Cpu}
          label="Compile"
          value={`${metrics.compileP50Ms.toFixed(1)} ms`}
          sub={`p95 ${metrics.compileP95Ms.toFixed(1)} ms`}
        />
        <HudStat
          icon={Activity}
          label="Streaming"
          value={`${metrics.streamLoadsPerSecond.toFixed(0)} in / ${metrics.streamEvictionsPerSecond.toFixed(0)} out`}
          sub={`${metrics.frameBudgetViolations} budget violations total`}
        />
      </div>

      <div className="flex items-center justify-between border-t border-white/[0.07] px-3.5 py-2 font-mono text-[10px] text-white/28">
        <span>LOD {metrics.trianglesByLod.map(compactNumber).join(' · ')}</span>
        <span>Q {Math.round(metrics.qualityScale * 100)}%</span>
      </div>
    </section>
  )
}

function HudStat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Cpu
  label: string
  value: string
  sub: string
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] text-white/32">
        <Icon size={9} />
        {label}
      </div>
      <div className="mt-1 font-mono text-[11px] tabular-nums text-white/72">{value}</div>
      <div className="mt-0.5 truncate text-[8px] text-white/25">{sub}</div>
    </div>
  )
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Math.round(value).toString()
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}
