import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

interface SectionProps {
  icon: LucideIcon
  title: string
  badge?: string | number
  children: ReactNode
}

interface CollapsibleSectionProps extends SectionProps {
  open: boolean
  onToggle: () => void
}

/** A section whose body is always shown: the tool and selection zones. */
export function Section({ icon: Icon, title, badge, children }: SectionProps) {
  return (
    <section className="border-b border-white/[0.07]">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <Icon size={12} strokeWidth={1.7} className="shrink-0 text-white/45" />
        <span className="panel-title min-w-0 flex-1 truncate">{title}</span>
        {badge !== undefined && (
          <span className="panel-meta max-w-[76px] shrink truncate font-mono">{badge}</span>
        )}
      </div>
      <div className="space-y-3 px-3 pb-3.5">{children}</div>
    </section>
  )
}

/** A scene section: closed by default, opened by the tool or by the user. */
export function CollapsibleSection({
  icon: Icon,
  title,
  badge,
  open,
  onToggle,
  children,
}: CollapsibleSectionProps) {
  return (
    <section className="border-b border-white/[0.07]">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:bg-white/[0.025]"
        onClick={onToggle}
      >
        <ChevronRight
          size={11}
          className={`shrink-0 text-white/28 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Icon size={12} strokeWidth={1.7} className="shrink-0 text-white/45" />
        <span className="panel-title min-w-0 flex-1 truncate">{title}</span>
        {badge !== undefined && (
          <span className="panel-meta max-w-[76px] shrink truncate font-mono">{badge}</span>
        )}
      </button>
      {open && <div className="space-y-3 px-3 pb-3.5">{children}</div>}
    </section>
  )
}
