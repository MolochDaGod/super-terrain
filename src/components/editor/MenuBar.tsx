import { memo } from 'react'
import {
  Box,
  Copy,
  Crosshair,
  Cpu,
  Eye,
  FileUp,
  Gauge,
  Layers3,
  Lightbulb,
  Flashlight,
  Minus,
  Move3D,
  Mountain,
  MousePointer2,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Save,
  Scaling,
  Sparkles,
  Trash2,
  Triangle,
  HardDrive,
} from 'lucide-react'
import type { BenchmarkScenario, WorldTerrain } from '../../terrain/WorldTerrain'
import type {
  DprMode,
  EditorStore,
  TerrainOverlay,
  TransformMode,
} from '../../terrain/editor/EditorStore'
import type { TerrainRenderMode } from '../../terrain/rendering/renderModes'
import { useEditorSnapshot, useTerrainMetrics } from '../../terrain/react/hooks'
import {
  Menu,
  MenuBar,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
} from './ui/Menu'
import {
  addCsgVolume,
  adjustBrushRadius,
  addLight,
  addRock,
  addSculptLayer,
  clearSelection,
  convertRockToCsg,
  currentSelection,
  deleteSelection,
  duplicateSelection,
  focusSelection,
  pickCsgMesh,
  resetWorld,
  saveWorld,
  toggleSelectionVisible,
} from './editorActions'

const OVERLAY_LABELS: { value: TerrainOverlay; label: string }[] = [
  { value: 'none', label: 'No overlay' },
  { value: 'sections', label: 'Section grid' },
  { value: 'lod', label: 'LOD tiers' },
  { value: 'density', label: 'Triangle density' },
  { value: 'streaming', label: 'Streaming state' },
]

const QUALITY_LABELS: { value: TerrainRenderMode; label: string }[] = [
  { value: 'preview', label: 'Preview quality' },
  { value: 'full', label: 'Full quality' },
]

const DPR_LABELS: { value: DprMode; label: string }[] = [
  { value: 'low', label: 'Resolution 0.75×' },
  { value: 'medium', label: 'Resolution 1×' },
  { value: 'full', label: 'Resolution native' },
]

const TRANSFORM_LABELS: {
  value: TransformMode
  label: string
  shortcut: string
  icon: typeof Move3D
}[] = [
  { value: 'translate', label: 'Move', shortcut: 'W', icon: Move3D },
  { value: 'rotate', label: 'Rotate', shortcut: 'E', icon: RotateCw },
  { value: 'scale', label: 'Scale', shortcut: 'R', icon: Scaling },
]

const BENCHMARKS: { id: BenchmarkScenario; label: string }[] = [
  { id: 'sculpt-torture', label: 'Sculpt stress' },
  { id: 'rebuild-torture', label: 'Rebuild stress' },
  { id: 'streaming-torture', label: 'Streaming stress' },
]

interface EditorMenuBarProps {
  terrain: WorldTerrain
  editor: EditorStore
}

/**
 * The application menu: every action the editor can perform is reachable from
 * here, including the ones the toolbars also expose. Telemetry sits on the
 * right as icon-and-number chips, since a menu bar is a place for verbs and a
 * readout only needs to be legible at a glance.
 */
export function EditorMenuBar({ terrain, editor }: EditorMenuBarProps) {
  const snapshot = useEditorSnapshot(editor)
  const selection = currentSelection(terrain, snapshot)
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const mod = isMac ? '⌘' : 'Ctrl+'

  return (
    <header className="pointer-events-auto absolute inset-x-0 top-0 z-30 flex h-9 items-center gap-3 border-b border-white/[0.08] bg-[#07100f]/92 pl-2.5 pr-2 backdrop-blur-xl">
      <div className="flex shrink-0 items-center gap-2 pr-1">
        <span className="grid size-5 place-items-center rounded border border-[#77e8be]/25 bg-[#77e8be]/10 text-[#a6f2d5]">
          <Sparkles size={11} strokeWidth={1.9} />
        </span>
        <span className="hidden text-[11px] font-semibold tracking-tight text-white/78 sm:inline">
          Mesh Terrain
        </span>
      </div>

      <MenuBar>
        <Menu label="File">
          <MenuItem
            label="Save world"
            shortcut={`${mod}S`}
            icon={Save}
            onSelect={() => void saveWorld(terrain, editor)}
          />
          <MenuItem
            label="Import GLB as CSG volume…"
            icon={FileUp}
            onSelect={() => pickCsgMesh(terrain, editor)}
          />
          <MenuSeparator />
          <MenuItem
            label="Reset local edits…"
            icon={RotateCcw}
            onSelect={() => void resetWorld(terrain, editor)}
          />
        </Menu>

        <Menu label="Edit">
          <MenuItem
            label="Duplicate"
            shortcut={`${mod}D`}
            icon={Copy}
            disabled={!selection?.canDuplicate}
            onSelect={() => duplicateSelection(terrain, editor)}
          />
          <MenuItem
            label="Delete"
            shortcut="Del"
            icon={Trash2}
            disabled={!selection}
            onSelect={() => deleteSelection(terrain, editor)}
          />
          <MenuItem
            label={selection?.visible === false ? 'Show' : 'Hide'}
            shortcut="Alt+H"
            icon={Eye}
            disabled={!selection}
            onSelect={() => toggleSelectionVisible(terrain, editor)}
          />
          <MenuSeparator />
          <MenuGroupLabel>Brush</MenuGroupLabel>
          <MenuItem
            label="Shrink radius"
            shortcut="["
            icon={Minus}
            onSelect={() => adjustBrushRadius(editor, -2)}
          />
          <MenuItem
            label="Grow radius"
            shortcut="]"
            icon={Plus}
            onSelect={() => adjustBrushRadius(editor, 2)}
          />
        </Menu>

        <Menu label="Selection">
          <MenuItem
            label="Select tool"
            shortcut="1"
            icon={MousePointer2}
            checked={snapshot.tool === 'select'}
            onSelect={() =>
              editor.patch({ tool: 'select', status: 'Inspect tool active' })
            }
          />
          <MenuSeparator />
          <MenuGroupLabel>Transform</MenuGroupLabel>
          {TRANSFORM_LABELS.map(({ value, label, shortcut, icon }) => (
            <MenuItem
              key={value}
              label={label}
              shortcut={shortcut}
              icon={icon}
              checked={snapshot.transformMode === value}
              onSelect={() =>
                editor.patch({ transformMode: value, tool: 'select' })
              }
            />
          ))}
          <MenuSeparator />
          <MenuItem
            label="Frame selection"
            shortcut="F"
            icon={Crosshair}
            disabled={!selection}
            onSelect={() => focusSelection(terrain, editor)}
          />
          <MenuItem
            label="Deselect"
            shortcut="Esc"
            disabled={!selection}
            onSelect={() => clearSelection(editor)}
          />
          <MenuSeparator />
          <MenuGroupLabel>Convert rock</MenuGroupLabel>
          <MenuItem
            label="Snapshot as CSG subtract"
            disabled={selection?.kind !== 'rock'}
            onSelect={() => void convertRockToCsg(terrain, editor, 'subtract')}
          />
          <MenuItem
            label="Snapshot as CSG union"
            disabled={selection?.kind !== 'rock'}
            onSelect={() => void convertRockToCsg(terrain, editor, 'add')}
          />
        </Menu>

        <Menu label="Add">
          <MenuItem
            label="Granite rock at cursor"
            icon={Mountain}
            onSelect={() => addRock(terrain, editor)}
          />
          <MenuItem
            label="Random granite rock"
            icon={Mountain}
            onSelect={() => addRock(terrain, editor, { randomize: true })}
          />
          <MenuSeparator />
          <MenuItem
            label="CSG subtract volume"
            icon={Box}
            onSelect={() => addCsgVolume(terrain, editor, 'subtract')}
          />
          <MenuItem
            label="CSG union volume"
            icon={Box}
            onSelect={() => addCsgVolume(terrain, editor, 'add')}
          />
          <MenuItem
            label="Import GLB as CSG volume…"
            icon={FileUp}
            onSelect={() => pickCsgMesh(terrain, editor)}
          />
          <MenuSeparator />
          <MenuItem
            label="Point light"
            icon={Lightbulb}
            onSelect={() => addLight(editor, 'point')}
          />
          <MenuItem
            label="Spot light"
            icon={Flashlight}
            onSelect={() => addLight(editor, 'spot')}
          />
          <MenuSeparator />
          <MenuItem
            label="Sculpt layer"
            icon={Layers3}
            onSelect={() => addSculptLayer(terrain, editor)}
          />
        </Menu>

        <Menu label="View">
          <MenuGroupLabel>Camera</MenuGroupLabel>
          <MenuItem
            label="Orbit"
            checked={snapshot.cameraMode === 'orbit'}
            onSelect={() =>
              editor.patch({ cameraMode: 'orbit', status: 'Orbit camera active' })
            }
          />
          <MenuItem
            label="Fly"
            checked={snapshot.cameraMode === 'fly'}
            onSelect={() => editor.patch({ cameraMode: 'fly' })}
          />
          <MenuSeparator />
          <MenuGroupLabel>Rendering</MenuGroupLabel>
          {QUALITY_LABELS.map(({ value, label }) => (
            <MenuItem
              key={value}
              label={label}
              checked={snapshot.renderMode === value}
              onSelect={() => editor.patch({ renderMode: value })}
            />
          ))}
          {DPR_LABELS.map(({ value, label }) => (
            <MenuItem
              key={value}
              label={label}
              checked={snapshot.dprMode === value}
              onSelect={() => editor.patch({ dprMode: value })}
            />
          ))}
          <MenuSeparator />
          <MenuGroupLabel>Overlay</MenuGroupLabel>
          {OVERLAY_LABELS.map(({ value, label }) => (
            <MenuItem
              key={value}
              label={label}
              checked={snapshot.overlay === value}
              onSelect={() => {
                editor.patch({ overlay: value })
                terrain.setOverlay(value)
              }}
            />
          ))}
          <MenuSeparator />
          <MenuItem
            label="Performance HUD"
            shortcut="H"
            checked={snapshot.showHud}
            onSelect={() => editor.patch({ showHud: !snapshot.showHud })}
          />
          <MenuItem
            label="Hide all editor UI"
            icon={Eye}
            onSelect={() =>
              editor.patch({
                uiViewMode: 'clean',
                cursorVisible: false,
                status: 'Clean viewport · use the eye button to restore the UI',
              })
            }
          />
        </Menu>

        <Menu label="Run">
          <MenuGroupLabel>Stress scenarios</MenuGroupLabel>
          {BENCHMARKS.map(({ id, label }) => (
            <MenuItem
              key={id}
              label={label}
              icon={Play}
              onSelect={() => {
                terrain.startBenchmark(id)
                editor.patch({
                  showHud: true,
                  status: `${label} running for seven seconds`,
                })
              }}
            />
          ))}
          <MenuSeparator />
          <MenuItem
            label="Show frame telemetry"
            shortcut="H"
            checked={snapshot.showHud}
            onSelect={() => editor.patch({ showHud: !snapshot.showHud })}
          />
        </Menu>

        <Menu label="Help">
          <MenuItem
            label="Controls & shortcuts"
            shortcut="?"
            onSelect={() => editor.patch({ showHelp: true })}
          />
        </Menu>
      </MenuBar>

      <TelemetryChips terrain={terrain} editor={editor} />
    </header>
  )
}

/**
 * Its own subscriber: renderer telemetry ticks at 10 Hz and the menus have no
 * reason to reconcile with it.
 */
const TelemetryChips = memo(function TelemetryChips({
  terrain,
  editor,
}: EditorMenuBarProps) {
  const metrics = useTerrainMetrics(terrain)
  const snapshot = useEditorSnapshot(editor)
  const targetFrameMs = 1000 / terrain.config.targetFps
  const slow = metrics.averageFrameMs > targetFrameMs * 1.08
  const busy = metrics.workerActiveJobs > 0

  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      <Chip
        icon={Gauge}
        value={metrics.fps.toFixed(0)}
        tone={slow ? 'warn' : 'ok'}
        title={`${metrics.fps.toFixed(0)} frames per second · ${metrics.averageFrameMs.toFixed(2)} ms average frame`}
      />
      <Chip
        icon={Triangle}
        value={compact(metrics.trianglesRendered)}
        title={`${metrics.trianglesRendered.toLocaleString()} triangles across ${metrics.visibleSections} visible sections`}
      />
      <Chip
        icon={Cpu}
        value={busy ? `${metrics.workerActiveJobs}/${metrics.workerQueuedJobs}` : '0'}
        tone={busy ? 'busy' : 'muted'}
        title={`${metrics.workerActiveJobs} compiling · ${metrics.workerQueuedJobs} queued`}
      />
      <Chip
        icon={HardDrive}
        value={compactBytes(metrics.gpuBytes)}
        title={`${metrics.gpuResidentSections} sections resident on the GPU`}
        className="hidden xl:flex"
      />
      <button
        type="button"
        aria-label="Toggle frame telemetry"
        title="Frame telemetry · H"
        data-active={snapshot.showHud}
        className="menu-icon-button ml-1"
        onClick={() => editor.patch({ showHud: !snapshot.showHud })}
      >
        <Gauge size={13} />
      </button>
      <button
        type="button"
        aria-label="Hide editor UI"
        title="Clean viewport"
        className="menu-icon-button"
        onClick={() =>
          editor.patch({
            uiViewMode: 'clean',
            cursorVisible: false,
            status: 'Clean viewport',
          })
        }
      >
        <Eye size={13} />
      </button>
    </div>
  )
})

function Chip({
  icon: Icon,
  value,
  title,
  tone = 'default',
  className = '',
}: {
  icon: typeof Gauge
  value: string
  title: string
  tone?: 'default' | 'ok' | 'warn' | 'busy' | 'muted'
  className?: string
}) {
  return (
    <span className={`telemetry-chip ${className}`} data-tone={tone} title={title}>
      <Icon size={11} />
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  )
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`
  return Math.round(value).toString()
}

function compactBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`
  return `${Math.round(bytes / 1024 ** 2)}M`
}
