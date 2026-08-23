import { AlertTriangle, Circle, Crosshair, Grid2X2, Orbit, Plane } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot, useTerrainMetrics } from '../../terrain/react/hooks'
import { activeRadius, currentSelection } from './editorActions'
import { TOOL_BY_ID } from './tools'

interface StatusBarProps {
  terrain: WorldTerrain
  editor: EditorStore
}

/**
 * The context line: what the pointer is over, what is selected and what the
 * next click will do. Frame telemetry belongs to the menu bar chips and the
 * HUD, so nothing here duplicates a number that is already on screen.
 */
export function StatusBar({ terrain, editor }: StatusBarProps) {
  const snapshot = useEditorSnapshot(editor)
  const metrics = useTerrainMetrics(terrain)
  const tool = TOOL_BY_ID[snapshot.tool]
  const selection = currentSelection(terrain, snapshot)
  const showsRadius =
    tool.kind === 'sculpt' ||
    tool.kind === 'paint' ||
    tool.kind === 'water' ||
    tool.id === 'tunnel' ||
    tool.id === 'dig'

  return (
    <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex h-7 items-center gap-2.5 border-t border-white/[0.08] bg-[#07100f]/92 px-3 text-[10px] text-white/40 backdrop-blur-xl">
      <span className="flex shrink-0 items-center gap-1.5 text-white/62">
        <tool.icon size={11} strokeWidth={1.8} />
        {tool.label}
        {showsRadius && (
          <span className="font-mono tabular-nums text-white/34">
            r {activeRadius(snapshot).toFixed(0)} m
          </span>
        )}
      </span>

      <Divider />

      <span className="min-w-0 flex-1 truncate">{snapshot.status}</span>

      {metrics.failedSections > 0 && (
        <>
          <span
            className="flex shrink-0 items-center gap-1.5 text-[#ff9a6f]"
            // A section that fails to compile keeps its last geometry until an
            // LOD change or eviction takes it, and then the ground is simply
            // gone with nothing able to restore it. Never let that be silent.
            title={metrics.lastCompileError ?? 'Terrain compilation failed'}
          >
            <AlertTriangle size={10} strokeWidth={2.2} />
            {metrics.failedSections} section{metrics.failedSections === 1 ? '' : 's'} failed to compile
          </span>
          <Divider />
        </>
      )}

      {selection && (
        <>
          <span className="hidden shrink-0 items-center gap-1.5 text-[#b7f6df]/80 md:flex">
            <Circle size={8} fill="currentColor" strokeWidth={0} />
            <span className="max-w-[180px] truncate">{selection.name}</span>
          </span>
          <Divider className="hidden md:block" />
        </>
      )}

      <span className="hidden shrink-0 items-center gap-1.5 font-mono tabular-nums lg:flex">
        <Crosshair size={10} />
        {snapshot.cursorVisible
          ? `${round(snapshot.cursorPosition.x)} ${round(snapshot.cursorPosition.y)} ${round(snapshot.cursorPosition.z)}`
          : '— — —'}
      </span>

      {snapshot.worldCursor && (
        <span
          className="hidden shrink-0 items-center gap-1.5 font-mono tabular-nums text-[#ffd08a]/70 lg:flex"
          title="Placed 3D cursor · where Add puts the next object"
        >
          <Crosshair size={10} strokeWidth={2.2} />
          {`${round(snapshot.worldCursor.x)} ${round(snapshot.worldCursor.y)} ${round(snapshot.worldCursor.z)}`}
        </span>
      )}

      {snapshot.selectedSection && (
        <span className="hidden shrink-0 items-center gap-1.5 font-mono lg:flex">
          <Grid2X2 size={10} />
          {snapshot.selectedSection}
        </span>
      )}

      <Divider className="hidden sm:block" />

      <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
        {snapshot.cameraMode === 'fly' ? <Plane size={10} /> : <Orbit size={10} />}
        {snapshot.cameraMode === 'fly' ? 'Fly' : 'Orbit'}
      </span>

      <span className="flex shrink-0 items-center gap-1.5 text-[#9de7cd]/70">
        <span className="size-1 rounded-full bg-[#77e8be]" />
        WebGPU
      </span>
    </footer>
  )
}

function Divider({ className = '' }: { className?: string }) {
  return <span className={`h-3 w-px shrink-0 bg-white/[0.09] ${className}`} />
}

function round(value: number): string {
  return value.toFixed(0).padStart(1, '0')
}
