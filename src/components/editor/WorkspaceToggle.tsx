export type Workspace = 'terrain' | 'tree'

interface WorkspaceToggleProps {
  workspace: Workspace
  onChange: (workspace: Workspace) => void
}

/** The editor-level switch. Both workspaces keep this in the same top-bar slot. */
export function WorkspaceToggle({
  workspace,
  onChange,
}: WorkspaceToggleProps) {
  return (
    <div
      className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center rounded-md border border-white/[0.09] bg-black/20 p-0.5 shadow-inner"
      role="group"
      aria-label="Workspace"
    >
      <WorkspaceButton
        label="Terrain"
        active={workspace === 'terrain'}
        onClick={() => onChange('terrain')}
      />
      <WorkspaceButton
        label="Tree"
        active={workspace === 'tree'}
        onClick={() => onChange('tree')}
      />
    </div>
  )
}

function WorkspaceButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-active={active}
      className="min-w-[68px] rounded-[0.3rem] border border-transparent px-3 py-1 text-[10px] font-medium tracking-wide text-white/42 transition hover:text-white/75 data-[active=true]:border-white/[0.08] data-[active=true]:bg-white/[0.08] data-[active=true]:text-white/88 data-[active=true]:shadow-sm"
      onClick={onClick}
    >
      {label}
    </button>
  )
}
