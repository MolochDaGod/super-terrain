import type { LucideIcon } from 'lucide-react'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
  /** Shown on hover, so the control never needs a caption above it. */
  hint?: string
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Defaults to one column per option. */
  columns?: number
  ariaLabel: string
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  columns,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="seg"
      style={{
        gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map(({ value: optionValue, label, icon: Icon, hint }) => (
        <button
          key={optionValue}
          type="button"
          title={hint ?? label}
          aria-pressed={value === optionValue}
          data-active={value === optionValue}
          onClick={() => onChange(optionValue)}
        >
          {Icon && <Icon size={12} className="shrink-0" />}
          <span className="truncate">{label}</span>
        </button>
      ))}
    </div>
  )
}
