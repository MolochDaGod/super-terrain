import { Activity } from 'lucide-react'
import type { TreeEditorStore } from '../TreeEditorStore'
import { useTreeEditorSnapshot } from '../useTreeEditorSnapshot'

/** Sits where the terrain editor's HUD does, so the two are comparable. */
export function TreePerformanceHud({ store }: { store: TreeEditorStore }) {
  const snapshot = useTreeEditorSnapshot(store)
  if (!snapshot.showHud) return null
  const prototypes = Object.values(snapshot.prototypes)
  const compiled = prototypes.filter((prototype) => prototype.asset)
  const counts = new Map<string, number>()
  for (const placement of snapshot.placements) {
    counts.set(placement.prototypeId, (counts.get(placement.prototypeId) ?? 0) + 1)
  }
  const triangles = compiled.reduce((sum, prototype) => {
    const perTree = (prototype.asset?.lods[snapshot.lod].wood.indices.length ?? 0) / 3
    return sum + perTree * (counts.get(prototype.id) ?? 0)
  }, 0)
  const uniqueTriangles = compiled.reduce(
    (sum, prototype) =>
      sum + (prototype.asset?.lods[snapshot.lod].wood.indices.length ?? 0) / 3,
    0,
  )

  return (
    <section className="pointer-events-none absolute bottom-9 left-[68px] z-20 hidden w-[286px] overflow-hidden rounded-lg border border-white/[0.09] bg-[#08110f]/90 shadow-2xl shadow-black/25 backdrop-blur-xl lg:block xl:left-[576px]">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2 text-[10px] text-white/55">
        <span className="flex items-center gap-2">
          <Activity size={11} /> Forest performance
        </span>
        <span className="font-mono text-[#77e8be]">
          {compiled.length}/{prototypes.length}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 p-3">
        <Metric label="Placed stems" value={compact(snapshot.placements.length)} />
        <Metric label="Draw prototypes" value={compact(compiled.length)} />
        <Metric label="Scene triangles" value={compact(triangles)} />
        <Metric label="Unique geometry" value={compact(uniqueTriangles)} />
      </div>
      <p className="border-t border-white/[0.07] px-3 py-2 text-[9px] leading-relaxed text-white/25">
        Matching trees share compiled geometry, materials, textures and instanced
        draw batches.
      </p>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[9px] uppercase tracking-wide text-white/25">{label}</span>
      <span className="mt-1 block font-mono text-[11px] text-white/68">{value}</span>
    </div>
  )
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Math.round(value).toString()
}
