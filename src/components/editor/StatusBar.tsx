import { Database, Orbit, Plane } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot, useTerrainMetrics } from '../../terrain/react/hooks'

interface StatusBarProps {
  terrain: WorldTerrain
  editor: EditorStore
}

export function StatusBar({ terrain, editor }: StatusBarProps) {
  const snapshot = useEditorSnapshot(editor)
  const metrics = useTerrainMetrics(terrain)
  return (
    <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex h-7 items-center gap-3 border-t border-white/[0.08] bg-[#07100f]/92 px-3 font-mono text-[8px] uppercase tracking-[0.08em] text-white/32 backdrop-blur-xl">
      <span className="flex items-center gap-1.5 text-[#9de7cd]/70">
        <span className="size-1 rounded-full bg-[#77e8be]" />
        WebGPU
      </span>
      <span className="h-3 w-px bg-white/[0.08]" />
      <span>{snapshot.status}</span>
      <div className="ml-auto hidden items-center gap-3 sm:flex">
        {snapshot.selectedSection && <span>Section {snapshot.selectedSection}</span>}
        <span className="flex items-center gap-1.5">
          <Database size={9} /> {metrics.sourceResidentSections} source
        </span>
        <span className="flex items-center gap-1.5">
          {snapshot.cameraMode === 'fly' ? <Plane size={9} /> : <Orbit size={9} />}
          {snapshot.cameraMode === 'fly'
            ? 'Fly · click capture · WASD · Shift boost · Esc release'
            : 'Orbit · LMB rotate · RMB pan · WASD translate'}
        </span>
      </div>
    </footer>
  )
}
