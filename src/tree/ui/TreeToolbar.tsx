import {
  Copy,
  PaintBucket,
  RefreshCw,
  Shuffle,
  Sprout,
  Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Menu, MenuBar, MenuItem, MenuSeparator } from '../../components/editor/ui/Menu'
import type { FoliageEditorStore } from '../../foliage/FoliageEditorStore'
import { useFoliageSnapshot } from '../../foliage/react/useFoliageSnapshot'
import { selectedTreePrototype, type TreeEditorStore } from '../TreeEditorStore'
import { useTreeEditorSnapshot } from '../useTreeEditorSnapshot'
import {
  TREE_TOOLS,
  activeTreeTool,
  setTreeWorkspaceTool,
} from './treeTools'

/**
 * The one toolbar.
 *
 * The workspace used to carry two of these stacked on top of each other — the
 * tree tools at `top-[46px]` and the ground brush at `top-11`, forty-four
 * pixels apart on a bar nine pixels taller than that — so the palettes
 * overlapped the buttons above them. They were two bars because they came from
 * two stores, which is a reason for the code to be split and no reason at all
 * for the interface to be. Modes are on the left, verbs on the right, and
 * everything either one needs to know sits in the panels beside the viewport.
 */
export function TreeToolbar({
  store,
  foliage,
}: {
  store: TreeEditorStore
  foliage: FoliageEditorStore
}) {
  const snapshot = useTreeEditorSnapshot(store)
  const floor = useFoliageSnapshot(foliage)
  const tool = activeTreeTool(snapshot, floor)
  const prototype = selectedTreePrototype(snapshot)
  const selected = Boolean(snapshot.selectedPlacementId)

  return (
    <div
      role="toolbar"
      aria-label="Forest tools and actions"
      className="pointer-events-auto absolute left-1/2 top-[46px] z-20 flex min-h-9 w-[calc(100vw-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-0.5 rounded-lg border border-white/[0.09] bg-[#0b1312]/92 px-1 py-0.5 shadow-2xl shadow-black/30 backdrop-blur-xl min-[900px]:w-max min-[900px]:flex-nowrap"
    >
      {TREE_TOOLS.map((definition) => (
        <BarButton
          key={definition.id}
          icon={definition.icon}
          label={definition.label}
          hint={definition.description}
          shortcut={definition.shortcut}
          active={tool === definition.id}
          onClick={() => setTreeWorkspaceTool(store, foliage, definition.id)}
        />
      ))}

      <Divider />

      <BarButton
        icon={Copy}
        label="Duplicate tree"
        hint="Places a second instance of the same prototype beside this one. It shares the compiled geometry, so it costs a matrix and nothing else."
        shortcut="⌘D"
        disabled={!selected}
        onClick={() => store.duplicateSelected()}
      />
      <BarButton
        icon={Trash2}
        label="Delete tree"
        hint="Removes this instance. The prototype stays in the catalogue for the trees still using it."
        shortcut="Del"
        danger
        disabled={!selected}
        onClick={() => store.deleteSelected()}
      />

      <Divider />

      <BarButton
        icon={Shuffle}
        label="New topology"
        hint="Rolls a new seed for the selected prototype and recompiles it. Every tree sharing the variation changes with it."
        disabled={!prototype || prototype.building}
        onClick={() => store.randomizeSelected()}
      />
      <BarButton
        icon={RefreshCw}
        label="Recompile"
        hint="Rebuilds the selected prototype's geometry from its current parameters."
        active={Boolean(prototype?.dirty)}
        disabled={!prototype || prototype.building}
        onClick={() => store.recompileSelected()}
      />

      <Divider />

      <MenuBar>
        <Menu label="Floor" caret>
          <MenuItem
            label="Fill field with armed cover"
            icon={PaintBucket}
            onSelect={() => {
              foliage.enqueue({ kind: 'fill' })
              foliage.patch({ status: 'Field filled with the armed cover' })
            }}
          />
          <MenuItem
            label="Regrow from the preset"
            icon={Sprout}
            onSelect={() => {
              foliage.enqueue({ kind: 'reseed' })
              foliage.patch({ status: 'Floor regrown from the preset' })
            }}
          />
          <MenuSeparator />
          <MenuItem
            label="Clear every plant and layer"
            icon={Trash2}
            onSelect={() => {
              foliage.enqueue({ kind: 'clear' })
              foliage.patch({ status: 'Floor and ground cover cleared' })
            }}
          />
        </Menu>
      </MenuBar>
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
