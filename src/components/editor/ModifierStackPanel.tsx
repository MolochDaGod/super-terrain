import { memo } from 'react'
import {
  Eye,
  EyeOff,
  Layers3,
  Move3D,
  Trash2,
} from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import type { ModifierTransform, TerrainModifier } from '../../terrain/modifiers/types'
import { normalizedTransform } from '../../terrain/modifiers/transform'
import { tunnelPortalDistance } from '../../terrain/modifiers/tunnel'
import {
  useEditorSnapshot,
  useModifierRevision,
} from '../../terrain/react/hooks'
import { RangeField } from './RangeField'

interface ModifierStackPanelProps {
  terrain: WorldTerrain
  editor: EditorStore
}

function ModifierStackPanelView({ terrain, editor }: ModifierStackPanelProps) {
  useModifierRevision(terrain)
  const editorSnapshot = useEditorSnapshot(editor)
  const modifiers = terrain.modifiers.snapshot().reverse()
  const selected = modifiers.find(
    (modifier) => modifier.id === editorSnapshot.selectedModifierId,
  )

  return (
    <section className="border-b border-white/[0.07]">
      <header className="flex items-center justify-between px-4 pb-3 pt-4">
        <span className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/35">
          <Layers3 size={12} strokeWidth={1.7} /> Modifier stack
        </span>
        <span className="font-mono text-[8px] text-white/25">
          {modifiers.length} non-destructive
        </span>
      </header>

      <div className="max-h-44 space-y-1 overflow-y-auto px-3.5 pb-3">
        {modifiers.length === 0 && (
          <p className="rounded-md border border-dashed border-white/[0.08] p-3 text-[9px] text-white/28">
            A brush stroke or topology operation will appear here.
          </p>
        )}
        {modifiers.map((modifier, index) => (
          <ModifierRow
            key={modifier.id}
            modifier={modifier}
            index={modifiers.length - index}
            selected={modifier.id === selected?.id}
            onSelect={() =>
              editor.patch({
                selectedModifierId: modifier.id,
                status: `${modifierLabel(modifier)} modifier selected`,
              })
            }
            onToggle={() => {
              terrain.setModifierEnabled(modifier.id, !modifier.enabled)
              editor.patch({
                status: `${modifierLabel(modifier)} ${modifier.enabled ? 'disabled' : 'enabled'}`,
              })
            }}
            onDelete={() => {
              terrain.removeModifier(modifier.id)
              if (selected?.id === modifier.id) {
                editor.patch({ selectedModifierId: undefined })
              }
            }}
          />
        ))}
      </div>

      {selected && (
        <ModifierTransformEditor
          modifier={selected}
          onChange={(transform) => {
            terrain.updateModifierTransform(selected.id, transform)
            editor.patch({ status: 'Modifier transformed · affected sections queued' })
          }}
          onTunnelShapeChange={(values) => {
            terrain.updateTunnelShape(selected.id, values)
            editor.patch({ status: 'Tunnel shape changed · affected sections queued' })
          }}
        />
      )}
    </section>
  )
}

// The inspector also subscribes to 10 Hz renderer telemetry. This subtree has
// its own modifier/editor subscriptions, so reconciling every row again for an
// unrelated FPS update only creates garbage and periodic main-thread stalls.
const MemoizedModifierStackPanel = memo(ModifierStackPanelView)

export function ModifierStackPanel(props: ModifierStackPanelProps) {
  return <MemoizedModifierStackPanel {...props} />
}

function ModifierRow({
  modifier,
  index,
  selected,
  onSelect,
  onToggle,
  onDelete,
}: {
  modifier: TerrainModifier
  index: number
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={`group flex items-center gap-1 rounded-md border px-1.5 py-1.5 transition ${
        selected
          ? 'border-[#77e8be]/30 bg-[#77e8be]/[0.07]'
          : 'border-white/[0.06] bg-white/[0.018]'
      }`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={onSelect}
      >
        <span className="flex items-center gap-2">
          <span className="font-mono text-[8px] text-white/22">{index.toString().padStart(2, '0')}</span>
          <span className="min-w-0">
            <span className="block truncate text-[9px] text-white/68">
              {modifierLabel(modifier)}
            </span>
            {modifier.type === 'brush-stroke' && (
              <span className="mt-0.5 block font-mono text-[7px] text-white/24">
                {modifier.points.length} {modifier.points.length === 1 ? 'sample' : 'samples'} · one stroke
              </span>
            )}
            {modifier.type === 'boolean-subtract' && (
              <span className="mt-0.5 block font-mono text-[7px] text-white/24">
                {tunnelPortalDistance(modifier).toFixed(0)} m path · r {modifier.radius.toFixed(1)} m
              </span>
            )}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={modifier.enabled ? 'Disable modifier' : 'Enable modifier'}
        className="grid size-6 place-items-center rounded text-white/28 hover:bg-white/[0.06] hover:text-white/70"
        onClick={onToggle}
      >
        {modifier.enabled ? <Eye size={11} /> : <EyeOff size={11} />}
      </button>
      <button
        type="button"
        aria-label="Delete modifier"
        className="grid size-6 place-items-center rounded text-white/20 hover:bg-[#ff826f]/10 hover:text-[#ff826f]"
        onClick={onDelete}
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}

function ModifierTransformEditor({
  modifier,
  onChange,
  onTunnelShapeChange,
}: {
  modifier: TerrainModifier
  onChange: (transform: ModifierTransform) => void
  onTunnelShapeChange: (
    values: Partial<{ radius: number; depth: number }>,
  ) => void
}) {
  const transform = normalizedTransform(modifier.transform)
  const patchOffset = (axis: 'x' | 'y' | 'z', value: number) =>
    onChange({
      ...transform,
      offset: { ...transform.offset, [axis]: value },
    })

  return (
    <div className="space-y-3 border-t border-white/[0.06] bg-white/[0.018] px-4 py-3.5">
      <div className="flex items-center gap-2 text-[8px] font-semibold uppercase tracking-[0.14em] text-[#b7f6df]/55">
        <Move3D size={11} /> Transform selected modifier
      </div>
      {modifier.type === 'boolean-subtract' && (
        <>
          <RangeField
            label="Portal radius"
            value={modifier.radius}
            min={2}
            max={24}
            step={0.5}
            unit=" m"
            onChange={(radius) => onTunnelShapeChange({ radius })}
          />
          <RangeField
            label="Burial depth"
            value={modifier.depth}
            min={3}
            max={48}
            step={1}
            unit=" m"
            onChange={(depth) => onTunnelShapeChange({ depth })}
          />
        </>
      )}
      <RangeField label="Move X" value={transform.offset.x} min={-128} max={128} step={1} unit=" m" onChange={(value) => patchOffset('x', value)} />
      <RangeField label="Move Y" value={transform.offset.y} min={-96} max={96} step={1} unit=" m" onChange={(value) => patchOffset('y', value)} />
      <RangeField label="Move Z" value={transform.offset.z} min={-128} max={128} step={1} unit=" m" onChange={(value) => patchOffset('z', value)} />
      <RangeField
        label="Yaw"
        value={(transform.yaw * 180) / Math.PI}
        min={-180}
        max={180}
        step={1}
        unit="°"
        onChange={(value) => onChange({ ...transform, yaw: (value * Math.PI) / 180 })}
      />
      <RangeField label="Scale" value={transform.scale} min={0.25} max={4} step={0.05} unit="×" onChange={(scale) => onChange({ ...transform, scale })} />
    </div>
  )
}

function modifierLabel(modifier: TerrainModifier): string {
  switch (modifier.type) {
    case 'brush-stroke':
      return `${modifier.domain === 'mesh' ? 'Mesh' : 'Height'} · ${modifier.mode}`
    case 'boolean-subtract':
      return 'Mesh · tunnel subtract'
    case 'remesh':
      return 'Mesh · density'
    case 'tessellate':
      return 'Mesh · tessellate'
    case 'noise':
      return 'Height · noise'
    case 'field-displacement':
      return 'Field displacement'
  }
}
