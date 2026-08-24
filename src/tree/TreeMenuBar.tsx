import { Orbit, Plane } from 'lucide-react'
import { WorkspaceToggle, type Workspace } from '../components/editor/WorkspaceToggle'
import type { CameraMode, EditorStore } from '../terrain/editor/EditorStore'
import { useEditorSnapshot } from '../terrain/react/hooks'

interface TreeMenuBarProps {
  editor: EditorStore
  workspace: Workspace
  onWorkspaceChange: (workspace: Workspace) => void
}

/** The intentionally spare shell for the tree authoring workspace. */
export function TreeMenuBar({
  editor,
  workspace,
  onWorkspaceChange,
}: TreeMenuBarProps) {
  const { cameraMode } = useEditorSnapshot(editor)

  return (
    <header className="pointer-events-auto absolute inset-x-0 top-0 z-30 flex h-9 items-center border-b border-white/[0.08] bg-[#07100f]/92 px-2.5 backdrop-blur-xl">
      <div className="flex shrink-0 items-center gap-2">
        <span className="grid size-5 place-items-center rounded border border-[#77e8be]/25 bg-[#77e8be]/10 text-[#a6f2d5]">
          <TreeMark />
        </span>
        <span className="hidden text-[11px] font-semibold tracking-tight text-white/78 sm:inline">
          Mesh Tree
        </span>
      </div>

      <WorkspaceToggle workspace={workspace} onChange={onWorkspaceChange} />

      <div className="ml-auto flex items-center rounded-md border border-white/[0.08] bg-black/15 p-0.5">
        <CameraButton
          label="Orbit"
          icon={Orbit}
          active={cameraMode === 'orbit'}
          onClick={() => setCameraMode(editor, 'orbit')}
        />
        <CameraButton
          label="Fly"
          icon={Plane}
          active={cameraMode === 'fly'}
          onClick={() => setCameraMode(editor, 'fly')}
        />
      </div>
    </header>
  )
}

function CameraButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string
  icon: typeof Orbit
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={`${label} camera`}
      aria-label={`${label} camera`}
      aria-pressed={active}
      data-active={active}
      className="flex h-6 items-center gap-1.5 rounded-[0.3rem] border border-transparent px-2 text-[10px] text-white/38 transition hover:text-white/75 data-[active=true]:border-white/[0.07] data-[active=true]:bg-white/[0.07] data-[active=true]:text-[#b7f6df]"
      onClick={onClick}
    >
      <Icon size={11} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

function setCameraMode(editor: EditorStore, cameraMode: CameraMode): void {
  editor.patch({
    cameraMode,
    status:
      cameraMode === 'fly'
        ? 'Fly mode · click the viewport to capture the mouse'
        : 'Orbit camera active',
  })
}

function TreeMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 14V8.8M8 11l-2.1-1.5M8 9.3l2.4-1.7" />
      <path d="M8 2 4.7 7.4h2L4.4 11h7.2L9.3 7.4h2L8 2Z" />
    </svg>
  )
}
