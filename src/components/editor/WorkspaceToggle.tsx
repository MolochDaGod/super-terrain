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
      className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center rounded border border-white/[0.08] bg-black/15 p-px shadow-inner"
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
      className="min-w-[48px] rounded-[0.22rem] border border-transparent px-2 py-0.5 text-[9px] font-medium tracking-wide text-white/40 transition hover:text-white/75 data-[active=true]:border-white/[0.07] data-[active=true]:bg-white/[0.08] data-[active=true]:text-white/85"
      onClick={onClick}
    >
      {label}
    </button>
  )
}
