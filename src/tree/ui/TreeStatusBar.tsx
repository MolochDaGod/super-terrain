import { Activity, Gauge, Orbit, Plane } from 'lucide-react'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import type { FoliageEditorStore } from '../../foliage/FoliageEditorStore'
import { useFoliageSnapshot } from '../../foliage/react/useFoliageSnapshot'
import type { TreeLodLevel } from '../generator/types'
import { selectedTreePrototype, type TreeEditorStore } from '../TreeEditorStore'
import { useTreeEditorSnapshot } from '../useTreeEditorSnapshot'
import { TREE_TOOL_BY_ID, activeTreeTool } from './treeTools'

/**
 * The context line: what the pointer is about to do, and what the workspace is
 * busy with. It replaces two floating chips that used to sit over the viewport
 * — one at the top right for compilation state, one at the bottom middle for
 * render toggles — neither of which was where a viewer looks for status.
 */
export function TreeStatusBar({
  editor,
  store,
  foliage,
}: {
  editor: EditorStore
  store: TreeEditorStore
  foliage: FoliageEditorStore
}) {
  const snapshot = useTreeEditorSnapshot(store)
  const floor = useFoliageSnapshot(foliage)
  const { cameraMode } = useEditorSnapshot(editor)
  const tool = TREE_TOOL_BY_ID[activeTreeTool(snapshot, floor)]
  const brush = tool.id === 'grow' || tool.id === 'clear'
  const compiling = Object.values(snapshot.prototypes).filter(
    (prototype) => prototype.building,
  ).length
  const status = compiling > 0
    ? `${compiling} prototype${compiling === 1 ? '' : 's'} compiling · ${selectedTreePrototype(snapshot)?.status ?? snapshot.status}`
    : snapshot.status

  return (
    <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex h-7 items-center gap-2.5 border-t border-white/[0.08] bg-[#07100f]/92 px-3 text-[10px] text-white/40 backdrop-blur-xl">
      <span className="flex shrink-0 items-center gap-1.5 text-white/62">
        <tool.icon size={11} strokeWidth={1.8} />
        {tool.label}
        {brush && (
          <span className="font-mono tabular-nums text-white/34">
            r {floor.radius.toFixed(0)} m
          </span>
        )}
      </span>

      <Divider />

      <span
        className={`flex shrink-0 items-center gap-1.5 ${compiling > 0 ? 'text-amber-300/80' : ''}`}
      >
        <span
          className={`size-1.5 rounded-full ${compiling > 0 ? 'animate-pulse bg-amber-300' : 'bg-[#77e8be]'}`}
        />
      </span>
      <span className="min-w-0 flex-1 truncate">{status}</span>

      {snapshot.gi && snapshot.giStatus && (
        <>
          <span className="hidden shrink-0 text-emerald-300/60 md:inline">
            {snapshot.giStatus}
          </span>
          <Divider className="hidden md:block" />
        </>
      )}

      <span className="hidden shrink-0 items-center gap-1.5 font-mono tabular-nums md:flex">
        {snapshot.placements.length} stems
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 font-mono tabular-nums lg:flex">
        {Object.keys(snapshot.prototypes).length} prototypes
      </span>

      <Divider className="hidden sm:block" />

      <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
        {cameraMode === 'fly' ? <Plane size={10} /> : <Orbit size={10} />}
        {cameraMode === 'fly' ? 'Fly' : 'Orbit'}
      </span>

      <span className="flex shrink-0 items-center gap-1.5 text-[#9de7cd]/70">
        <span className="size-1 rounded-full bg-[#77e8be]" />
        WebGPU
      </span>
    </footer>
  )
}

/** LOD and debug view, pinned by the viewport edge like the terrain editor's. */
export function TreeQuickControls({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  return (
    <div
      role="group"
      aria-label="Forest detail"
      className="pointer-events-auto absolute bottom-9 left-[268px] z-20 hidden h-9 items-center gap-2 rounded-lg border border-white/[0.09] bg-[#0b1312]/92 px-2 shadow-2xl shadow-black/30 backdrop-blur-xl xl:flex"
    >
      <Gauge size={12} className="shrink-0 text-white/28" />
      <div role="radiogroup" aria-label="Detail floor" className="flex items-center gap-0.5">
        {LOD_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={snapshot.lod === option.value}
            title={option.hint}
            data-active={snapshot.lod === option.value}
            className="quick-pill"
            onClick={() => store.patch({ lod: option.value })}
          >
            {option.short}
          </button>
        ))}
      </div>
      <span className="h-4 w-px bg-white/[0.09]" />
      <button
        type="button"
        title="Performance overlay"
        aria-pressed={snapshot.showHud}
        data-active={snapshot.showHud}
        className="quick-pill flex items-center gap-1"
        onClick={() => store.patch({ showHud: !snapshot.showHud })}
      >
        <Activity size={10} /> perf
      </button>
    </div>
  )
}

const LOD_OPTIONS: {
  value: TreeLodLevel
  short: string
  hint: string
}[] = [
  { value: 0, short: 'Auto', hint: 'Distance-based hero, mid and far detail' },
  { value: 1, short: 'Mid+', hint: 'Hero detail only on the selected tree' },
  { value: 2, short: 'Far', hint: 'Far detail everywhere except the selection' },
]

function Divider({ className = '' }: { className?: string }) {
  return <span className={`h-3 w-px shrink-0 bg-white/[0.09] ${className}`} />
}
