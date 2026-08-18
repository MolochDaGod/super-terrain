/** Placeholder for an empty list. The only prose the inspector keeps. */
export function EmptyHint({ children }: { children: string }) {
  return (
    <p className="rounded-md border border-dashed border-white/[0.08] p-3 text-[11px] text-white/28">
      {children}
    </p>
  )
}
