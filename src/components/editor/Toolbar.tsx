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
import { TOOLS, type ToolDefinition } from './tools'
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

/** Tool groups, in the order they appear on the bar. */
const GROUPS: ToolDefinition['group'][] = [
  'viewport',
  'primary',
  'detail',
  'paint',
  'forest',
  'topology',
]

/**
 * The one toolbar.
 *
 * Everything the pointer can be put into a mode to do, and everything that can
 * be done to the thing it selected, is on this bar — modes on the left, verbs on
 * the right. The panels either side of the viewport hold no actions at all: the
 * left one lists what is in the scene, the right one lists what the selected
 * thing's numbers are.
 */
export function Toolbar({
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
      aria-label="Tools and object actions"
      // Absolutely positioned shrink-to-fit boxes use the space between
      // `left: 50%` and the right edge before the transform is applied. That
      // capped this bar at half the viewport and made it wrap on ordinary
      // desktop screens. Use its intrinsic width once all controls fit; only
      // genuinely narrow windows get the full-width wrapping layout.
      className="pointer-events-auto absolute left-1/2 top-[46px] z-20 flex min-h-9 w-[calc(100vw-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-0.5 rounded-lg border border-white/[0.09] bg-[#0b1312]/92 px-1 py-0.5 shadow-2xl shadow-black/30 backdrop-blur-xl min-[900px]:w-max min-[900px]:flex-nowrap"
    >
      {GROUPS.map((group, groupIndex) => (
        <div key={group} className="flex items-center gap-0.5">
          {groupIndex > 0 && <Divider />}
          {TOOLS.filter((tool) => tool.group === group).map((tool) => (
            <BarButton
              key={tool.id}
              icon={tool.icon}
              label={tool.label}
              hint={tool.description}
              shortcut={tool.shortcut}
              active={snapshot.tool === tool.id}
              onClick={() =>
                editor.patch({ tool: tool.id, status: `${tool.label} tool active` })
              }
            />
          ))}
        </div>
      ))}

      <Divider />

      {TRANSFORMS.map(({ mode, label, shortcut, icon }) => (
        <BarButton
          key={mode}
          icon={icon}
          label={label}
          hint={`Transform the selection along ${label === 'Scale' ? 'its own axes' : 'the world axes'}.`}
          shortcut={shortcut}
          active={snapshot.tool === 'select' && snapshot.transformMode === mode}
          onClick={() => editor.patch({ transformMode: mode, tool: 'select' })}
        />
      ))}

      <Divider />

      <MenuBar>
        <Menu label="Add" caret>
          <MenuItem
            label="Granite rock"
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
    </div>
  )
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-white/[0.09]" />
}

function BarButton({
  icon: Icon,
  label,
  hint,
  shortcut,
  active,
  disabled,
  danger,
  onClick,
}: {
  icon: LucideIcon
  label: string
  /** One line of explanation, shown under the label in the hover card. */
  hint?: string
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
      data-active={active}
      data-danger={danger}
      disabled={disabled}
      className="bar-button group relative"
      onClick={onClick}
    >
      <Icon size={14} strokeWidth={1.7} />
      <span className="tool-tip w-96">
        <span className="text-white/80">{label}</span>
        {shortcut && <kbd className="ml-2 text-white/35">{shortcut}</kbd>}
        {hint && (
          <span className="mt-1 block max-w-[420px] whitespace-normal text-[10px] leading-relaxed text-white/40">
            {hint}
          </span>
        )}
      </span>
    </button>
  )
}
