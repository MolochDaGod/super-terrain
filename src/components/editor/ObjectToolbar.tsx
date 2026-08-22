import {
  Box,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  FileUp,
  Flashlight,
  Layers3,
  Lightbulb,
  MousePointer2,
  Mountain,
  Move3D,
  RotateCw,
  Scaling,
  Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore, TransformMode } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot, useGraniteRockRevision, useModifierRevision } from '../../terrain/react/hooks'
import { Menu, MenuBar, MenuItem, MenuSeparator } from './ui/Menu'
import {
  addCsgVolume,
  addLight,
  addRock,
  addSculptLayer,
  currentSelection,
  deleteSelection,
  duplicateSelection,
  focusSelection,
  pickCsgMesh,
  toggleSelectionVisible,
} from './editorActions'

const TRANSFORMS: { mode: TransformMode; label: string; shortcut: string; icon: LucideIcon }[] = [
  { mode: 'translate', label: 'Move', shortcut: 'W', icon: Move3D },
  { mode: 'rotate', label: 'Rotate', shortcut: 'E', icon: RotateCw },
  { mode: 'scale', label: 'Scale', shortcut: 'R', icon: Scaling },
]

/**
 * The object toolbar: pick, place, transform and remove things in the
 * viewport. These are verbs, so they belong on a toolbar next to the viewport
 * and not among the parameter fields in the inspector — the inspector answers
 * "what is this object like", this bar answers "what do I do to it".
 */
export function ObjectToolbar({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  useModifierRevision(terrain)
  useGraniteRockRevision(terrain)
  const snapshot = useEditorSnapshot(editor)
  const selection = currentSelection(terrain, snapshot)

  return (
    <div
      role="toolbar"
      aria-label="Object actions"
      className="pointer-events-auto absolute left-3 top-[46px] z-20 flex h-9 items-center gap-1 rounded-lg border border-white/[0.09] bg-[#0b1312]/92 px-1 shadow-2xl shadow-black/30 backdrop-blur-xl"
    >
      <BarButton
        icon={MousePointer2}
        label="Select"
        shortcut="1"
        active={snapshot.tool === 'select'}
        onClick={() => editor.patch({ tool: 'select', status: 'Inspect tool active' })}
      />

      <Divider />

      {TRANSFORMS.map(({ mode, label, shortcut, icon }) => (
        <BarButton
          key={mode}
          icon={icon}
          label={label}
          shortcut={shortcut}
          active={snapshot.tool === 'select' && snapshot.transformMode === mode}
          onClick={() => editor.patch({ transformMode: mode, tool: 'select' })}
        />
      ))}

      <Divider />

      <MenuBar>
        <Menu label="Add" caret>
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
            label="Import GLB…"
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
      </MenuBar>

      <Divider />

      <BarButton
        icon={Copy}
        label="Duplicate"
        shortcut="⌘D"
        disabled={!selection?.canDuplicate}
        onClick={() => duplicateSelection(terrain, editor)}
      />
      <BarButton
        icon={selection?.visible === false ? EyeOff : Eye}
        label={selection?.visible === false ? 'Show' : 'Hide'}
        shortcut="Alt+H"
        disabled={!selection}
        onClick={() => toggleSelectionVisible(terrain, editor)}
      />
      <BarButton
        icon={Crosshair}
        label="Frame selection"
        shortcut="F"
        disabled={!selection}
        onClick={() => focusSelection(terrain, editor)}
      />
      <BarButton
        icon={Trash2}
        label="Delete"
        shortcut="Del"
        danger
        disabled={!selection}
        onClick={() => deleteSelection(terrain, editor)}
      />

      {selection && (
        <>
          <Divider />
          <span
            className="max-w-[140px] truncate pl-1 pr-1.5 text-[11px] text-white/50"
            title={`${selection.name} selected`}
          >
            {selection.name}
          </span>
        </>
      )}
    </div>
  )
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-white/[0.09]" />
}

function BarButton({
  icon: Icon,
  label,
  shortcut,
  active,
  disabled,
  danger,
  onClick,
}: {
  icon: LucideIcon
  label: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} · ${shortcut}` : label}
      data-active={active}
      data-danger={danger}
      disabled={disabled}
      className="bar-button"
      onClick={onClick}
    >
      <Icon size={14} strokeWidth={1.7} />
    </button>
  )
}
