import { Eye, EyeOff, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'

interface ListRowProps {
  title: string
  /** Secondary line; omit when the title already says everything. */
  meta?: ReactNode
  /** Rendered before the title, e.g. a stack index or a colour chip. */
  lead?: ReactNode
  selected: boolean
  onSelect: () => void
  visible?: boolean
  onToggleVisible?: () => void
  onDelete?: () => void
  deleteDisabled?: boolean
}

/** One entry in the layer, modifier and rock lists. */
export function ListRow({
  title,
  meta,
  lead,
  selected,
  onSelect,
  visible,
  onToggleVisible,
  onDelete,
  deleteDisabled,
}: ListRowProps) {
  return (
    <div className="list-row" data-selected={selected}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onSelect}>
        {lead}
        <span className="min-w-0">
          <span className="block truncate text-[11px] text-white/72">{title}</span>
          {meta !== undefined && (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-white/28">{meta}</span>
          )}
        </span>
      </button>
      {onToggleVisible && (
        <button
          type="button"
          className="icon-button"
          aria-label={visible ? `Hide ${title}` : `Show ${title}`}
          title={visible ? 'Hide' : 'Show'}
          onClick={onToggleVisible}
        >
          {visible ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          className="icon-button"
          data-danger="true"
          disabled={deleteDisabled}
          aria-label={`Delete ${title}`}
          title="Delete"
          onClick={onDelete}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}
