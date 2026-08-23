interface RangeFieldProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  /** Derived consequence of the value, shown beside the label. */
  hint?: string
  onChange: (value: number) => void
}

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  hint,
  onChange,
}: RangeFieldProps) {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <label className="block space-y-2.5">
      <span className="flex items-center justify-between gap-3 text-[11px] text-white/55">
        <span>
          {label}
          {hint ? <span className="ml-1.5 text-white/35">{hint}</span> : null}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-[#b7f6df]">
          {formatValue(value, step)}{unit}
        </span>
      </span>
      <input
        className="terrain-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--range-progress': `${progress}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function formatValue(value: number, step: number): string {
  if (step >= 1) return Math.round(value).toString()
  return value.toFixed(step < 0.1 ? 2 : 1)
}
