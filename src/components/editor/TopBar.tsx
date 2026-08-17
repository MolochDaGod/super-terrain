import { useState } from 'react'
import {
  Activity,
  Gem,
  HelpCircle,
  Orbit,
  Pencil,
  Plane,
  RotateCcw,
  Save,
  Sparkles,
} from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot, useTerrainMetrics } from '../../terrain/react/hooks'

interface TopBarProps {
  terrain: WorldTerrain
  editor: EditorStore
}

export function TopBar({ terrain, editor }: TopBarProps) {
  const [saving, setSaving] = useState(false)
  const metrics = useTerrainMetrics(terrain)
  const editorSnapshot = useEditorSnapshot(editor)

  const save = async () => {
    setSaving(true)
    editor.patch({ status: 'Saving changed terrain sections…' })
    try {
      await terrain.save()
      editor.patch({ status: 'Terrain edits saved locally' })
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    if (!window.confirm('Reset all local terrain edits to the demo world?')) return
    await terrain.resetEdits()
    editor.patch({ status: 'Terrain reset; sections rebuilding asynchronously' })
  }

  return (
    <header className="pointer-events-auto absolute inset-x-0 top-0 z-30 flex h-14 items-center border-b border-white/[0.08] bg-[#07100f]/88 px-3 backdrop-blur-xl sm:px-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid size-7 shrink-0 place-items-center rounded-md border border-[#77e8be]/25 bg-[#77e8be]/10 text-[#a6f2d5]">
          <Sparkles size={14} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 leading-none">
          <div className="flex items-baseline gap-2">
            <h1 className="truncate text-[12px] font-semibold tracking-[0.14em] text-white/90">
              MESH TERRAIN
            </h1>
            <span className="hidden font-mono text-[9px] text-white/28 sm:inline">LAB / 01</span>
          </div>
          <p className="mt-1 hidden text-[9px] tracking-wide text-white/36 sm:block">
            16 km world · {terrain.logicalSectionCount.toLocaleString()} logical sections
          </p>
        </div>
      </div>

      <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-2 2xl:flex">
        <span
          className={`size-1.5 rounded-full ${metrics.workerActiveJobs > 0 ? 'animate-pulse bg-[#65e8ff]' : 'bg-[#77e8be]'}`}
        />
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-white/48">
          {metrics.workerActiveJobs > 0
            ? `${metrics.workerActiveJobs} compiling · ${metrics.workerQueuedJobs} queued`
            : 'Workers idle'}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <div className="mr-1 flex items-center gap-0.5 rounded-md border border-white/[0.07] bg-white/[0.035] p-0.5">
          <RenderModeButton
            active={editorSnapshot.cameraMode === 'orbit'}
            label="Orbit camera"
            onClick={() => editor.patch({ cameraMode: 'orbit', status: 'Orbit camera active' })}
          >
            <Orbit size={12} /> Orbit
          </RenderModeButton>
          <RenderModeButton
            active={editorSnapshot.cameraMode === 'fly'}
            label="Fly camera — mouse look, WASD move, Shift boost"
            onClick={() => editor.patch({ cameraMode: 'fly' })}
          >
            <Plane size={12} /> Fly
          </RenderModeButton>
        </div>
        <div className="mr-1 flex items-center gap-0.5 rounded-md border border-white/[0.07] bg-white/[0.035] p-0.5">
          <RenderModeButton
            active={editorSnapshot.renderMode === 'preview'}
            label="Preview quality — fast editing"
            onClick={() => editor.patch({ renderMode: 'preview' })}
          >
            <Pencil size={12} /> Preview
          </RenderModeButton>
          <RenderModeButton
            active={editorSnapshot.renderMode === 'full'}
            label="Full quality — layered materials, parallax detail, atmosphere"
            onClick={() => editor.patch({ renderMode: 'full' })}
          >
            <Gem size={12} /> Full
          </RenderModeButton>
        </div>
        <div className="mr-1 hidden items-center gap-2 rounded-md border border-white/[0.07] bg-white/[0.035] px-2.5 py-1.5 lg:flex">
          <Activity size={12} className="text-[#77e8be]" />
          <span className="font-mono text-[9px] tabular-nums text-white/55">
            {metrics.fps.toFixed(0)} FPS
          </span>
          <span className="h-3 w-px bg-white/10" />
          <span className="font-mono text-[9px] tabular-nums text-white/38">
            {metrics.trianglesRendered.toLocaleString()} tris
          </span>
        </div>
        <TopButton
          label={editorSnapshot.showHud ? 'Hide performance HUD' : 'Show performance HUD'}
          onClick={() => editor.patch({ showHud: !editorSnapshot.showHud })}
        >
          <Activity size={14} />
        </TopButton>
        <TopButton label="Save terrain" disabled={saving} onClick={() => void save()}>
          <Save size={14} className={saving ? 'animate-pulse' : ''} />
        </TopButton>
        <TopButton label="Reset edits" onClick={() => void reset()}>
          <RotateCcw size={14} />
        </TopButton>
        <TopButton
          label="Editor help"
          onClick={() => editor.patch({ showHelp: !editorSnapshot.showHelp })}
        >
          <HelpCircle size={14} />
        </TopButton>
      </div>
    </header>
  )
}

interface RenderModeButtonProps {
  active: boolean
  label: string
  children: React.ReactNode
  onClick: () => void
}

function RenderModeButton({ active, label, children, onClick }: RenderModeButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-[9px] font-medium uppercase tracking-[0.1em] transition ${
        active
          ? 'bg-[#77e8be]/15 text-[#a6f2d5]'
          : 'text-white/40 hover:bg-white/[0.06] hover:text-white/75'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

interface TopButtonProps {
  label: string
  disabled?: boolean
  children: React.ReactNode
  onClick: () => void
}

function TopButton({ label, disabled, children, onClick }: TopButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="grid size-8 place-items-center rounded-md border border-transparent text-white/48 transition hover:border-white/10 hover:bg-white/[0.06] hover:text-white/85 disabled:opacity-40"
      onClick={onClick}
    >
      {children}
    </button>
  )
}
