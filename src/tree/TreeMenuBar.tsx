import {
  Copy,
  Eye,
  Gauge,
  Leaf,
  Orbit,
  Plane,
  RefreshCw,
  Sun,
  Trash2,
  TreePine,
} from 'lucide-react'
import {
  Menu,
  MenuBar,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
} from '../components/editor/ui/Menu'
import { WorkspaceToggle, type Workspace } from '../components/editor/WorkspaceToggle'
import type { CameraMode, EditorStore } from '../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../terrain/react/hooks'
import type { TreeDebugMode, TreeEditorStore } from './TreeEditorStore'
import { useTreeEditorSnapshot } from './useTreeEditorSnapshot'

/**
 * The diagnostic views, which used to live as seven two-letter pills on a bar
 * floating over the middle of the ground. They are a menu because that is what
 * they are: a rarely-used exclusive choice with names too long to abbreviate
 * into a viewport overlay without becoming unreadable.
 */
const DEBUG_MODES: { value: TreeDebugMode; label: string }[] = [
  { value: 'surface', label: 'Lit surface' },
  { value: 'skeleton', label: 'Skeleton' },
  { value: 'hierarchy', label: 'Branch hierarchy' },
  { value: 'continuations', label: 'Growth continuations' },
  { value: 'radii', label: 'Radii' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'topology', label: 'Topology' },
]

interface TreeMenuBarProps {
  editor: EditorStore
  store: TreeEditorStore
  workspace: Workspace
  onWorkspaceChange: (workspace: Workspace) => void
}

export function TreeMenuBar({
  editor,
  store,
  workspace,
  onWorkspaceChange,
}: TreeMenuBarProps) {
  const { cameraMode } = useEditorSnapshot(editor)
  const snapshot = useTreeEditorSnapshot(store)
  const selected = Boolean(snapshot.selectedPlacementId)

  return (
    <header className="pointer-events-auto absolute inset-x-0 top-0 z-30 flex h-9 items-center gap-3 border-b border-white/[0.08] bg-[#07100f]/92 pl-2.5 pr-2 backdrop-blur-xl">
      <div className="flex shrink-0 items-center gap-2 pr-1">
        <span className="grid size-5 place-items-center rounded border border-[#77e8be]/25 bg-[#77e8be]/10 text-[#a6f2d5]">
          <TreePine size={11} strokeWidth={1.9} />
        </span>
        <span className="hidden text-[11px] font-semibold tracking-tight text-white/78 sm:inline">
          Mesh Forest
        </span>
      </div>

      <MenuBar>
        <Menu label="Forest">
          <MenuItem
            label="Generate forest"
            onSelect={() => store.generateForest()}
          />
          <MenuItem
            label="Generate a different seed"
            onSelect={() => store.randomizeForest()}
          />
          <MenuSeparator />
          <MenuItem
            label="Cancel placement"
            shortcut="Esc"
            disabled={!snapshot.armedPrototypeId}
            onSelect={() => store.cancelPlacement()}
          />
          <MenuSeparator />
          <MenuItem
            label="Clear forest"
            icon={Trash2}
            disabled={snapshot.placements.length === 0}
            onSelect={() => store.clearForest()}
          />
        </Menu>
        <Menu label="Edit">
          <MenuItem
            label="Duplicate instance"
            shortcut="⌘D"
            icon={Copy}
            disabled={!selected}
            onSelect={() => store.duplicateSelected()}
          />
          <MenuItem
            label="Delete instance"
            shortcut="Del"
            icon={Trash2}
            disabled={!selected}
            onSelect={() => store.deleteSelected()}
          />
          <MenuSeparator />
          <MenuItem
            label="Recompile shared tree"
            icon={RefreshCw}
            disabled={!selected}
            onSelect={() => store.recompileSelected()}
          />
        </Menu>
        <Menu label="View">
          <MenuGroupLabel>Camera</MenuGroupLabel>
          <MenuItem
            label="Orbit camera"
            icon={Orbit}
            checked={cameraMode === 'orbit'}
            onSelect={() => setCameraMode(editor, 'orbit')}
          />
          <MenuItem
            label="Fly camera"
            icon={Plane}
            checked={cameraMode === 'fly'}
            onSelect={() => setCameraMode(editor, 'fly')}
          />
          <MenuSeparator />
          <MenuItem
            label="Show foliage"
            icon={Leaf}
            checked={snapshot.showFoliage}
            onSelect={() => store.patch({ showFoliage: !snapshot.showFoliage })}
          />
          <MenuItem
            label="Global illumination"
            icon={Sun}
            checked={snapshot.gi}
            onSelect={() =>
              store.patch({
                gi: !snapshot.gi,
                giStatus: snapshot.gi ? '' : 'GI: building…',
                status: snapshot.gi
                  ? 'Global illumination off'
                  : 'Global illumination on · voxelising the stand',
              })
            }
          />
          <MenuItem
            label="GI: irradiance only"
            icon={Eye}
            disabled={!snapshot.gi}
            checked={snapshot.giDebug}
            onSelect={() => store.patch({ giDebug: !snapshot.giDebug })}
          />
          <MenuSeparator />
          <MenuItem
            label="Performance overlay"
            icon={Gauge}
            checked={snapshot.showHud}
            onSelect={() => store.patch({ showHud: !snapshot.showHud })}
          />
          <MenuSeparator />
          <MenuGroupLabel>Diagnostic view</MenuGroupLabel>
          {DEBUG_MODES.map((mode) => (
            <MenuItem
              key={mode.value}
              label={mode.label}
              icon={mode.value === 'surface' ? Eye : undefined}
              checked={snapshot.debugMode === mode.value}
              onSelect={() => store.patch({ debugMode: mode.value })}
            />
          ))}
        </Menu>
      </MenuBar>

      <WorkspaceToggle workspace={workspace} onChange={onWorkspaceChange} />

      <div className="ml-auto hidden items-center gap-3 font-mono text-[9px] text-white/35 md:flex">
        {snapshot.gi && snapshot.giStatus && (
          <span className="text-emerald-300/60">{snapshot.giStatus}</span>
        )}
        <span>{snapshot.placements.length} trees</span>
        <span>{Object.keys(snapshot.prototypes).length} prototypes</span>
      </div>
    </header>
  )
}

function setCameraMode(editor: EditorStore, cameraMode: CameraMode): void {
  editor.patch({
    cameraMode,
    status: cameraMode === 'fly'
      ? 'Fly mode · click the viewport to capture the mouse'
      : 'Orbit camera active',
  })
}
