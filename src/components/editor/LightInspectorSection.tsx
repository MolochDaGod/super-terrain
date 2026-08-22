import { Flashlight, Lightbulb } from 'lucide-react'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import type { EditorLight, EditorLightPatch } from '../../terrain/editor/lights'
import type { Vec3Like } from '../../terrain/core/types'
import { RangeField } from './RangeField'
import { Section } from './ui/Section'

const RAD_TO_DEG = 180 / Math.PI

/**
 * Light parameters only. Selecting, moving, hiding and deleting a light are
 * object verbs and live on the object toolbar, so this panel never repeats
 * them with a second, differently-shaped button.
 */
export function LightInspectorSection({
  light,
  editor,
}: {
  light: EditorLight
  editor: EditorStore
}) {
  const Icon = light.type === 'point' ? Lightbulb : Flashlight
  const update = (values: EditorLightPatch) => editor.updateLight(light.id, values)

  return (
    <Section icon={Icon} title={light.name} badge={light.type.toUpperCase()}>
      <label className="block space-y-1.5">
        <span className="text-[11px] text-white/55">Name</span>
        <input
          type="text"
          className="text-input"
          value={light.name}
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>

      <div className="flex items-center gap-2">
        <label className="relative grid size-8 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-md border border-white/10">
          <span className="absolute inset-0" style={{ backgroundColor: light.color }} />
          <input
            type="color"
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Light color"
            value={light.color}
            onChange={(event) => update({ color: event.target.value })}
          />
        </label>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-white/55">Color</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase text-white/32">
            {light.color}
          </div>
        </div>
      </div>

      <RangeField label="Intensity" value={light.intensity} min={0} max={100} step={0.1} onChange={(intensity) => update({ intensity })} />
      <RangeField label="Range" value={light.distance} min={1} max={1000} step={1} unit=" m" onChange={(distance) => update({ distance })} />
      <RangeField label="Decay" value={light.decay} min={0} max={3} step={0.05} onChange={(decay) => update({ decay })} />

      <VectorFields
        label="Position"
        value={light.position}
        onChange={(position) => update({ position })}
      />

      {light.type === 'spot' && (
        <>
          <RangeField
            label="Cone angle"
            value={light.angle * RAD_TO_DEG}
            min={1}
            max={90}
            step={1}
            unit="°"
            onChange={(angle) => update({ angle: angle / RAD_TO_DEG })}
          />
          <RangeField label="Penumbra" value={light.penumbra} min={0} max={1} step={0.01} onChange={(penumbra) => update({ penumbra })} />
          <VectorFields
            label="Target"
            value={light.target}
            onChange={(target) => update({ target })}
          />
        </>
      )}
    </Section>
  )
}

function VectorFields({
  label,
  value,
  onChange,
}: {
  label: string
  value: Vec3Like
  onChange: (value: Vec3Like) => void
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[11px] text-white/55">{label}</legend>
      <div className="grid grid-cols-3 gap-1.5">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <label key={axis} className="relative">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[9px] uppercase text-white/24">
              {axis}
            </span>
            <input
              type="number"
              step={1}
              aria-label={`${label} ${axis.toUpperCase()}`}
              className="text-input pl-5 pr-1 font-mono tabular-nums"
              value={roundCoordinate(value[axis])}
              onChange={(event) =>
                onChange({ ...value, [axis]: Number(event.target.value) })
              }
            />
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100
}
