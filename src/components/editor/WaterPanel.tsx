import { Droplets } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore, WaterPaintMode } from '../../terrain/editor/EditorStore'
import { useEditorSnapshot, useWaterState } from '../../terrain/react/hooks'
import { RangeField } from './RangeField'
import { Section } from './ui/Section'
import { Segmented, type SegmentedOption } from './ui/Segmented'

const MODES: SegmentedOption<WaterPaintMode>[] = [
  { value: 'add', label: 'Flood', hint: 'Brush water into the ground under the cursor' },
  { value: 'remove', label: 'Drain', hint: 'Brush water away again' },
]

/**
 * Water parameters.
 *
 * Level is a world property rather than a brush property: there is one surface,
 * and the brush only decides where it is allowed to be. Raising the level
 * therefore floods further up every slope that is already wet, which is what a
 * water level means and what makes it worth exposing as a number at all.
 */
export function WaterPanel({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  const snapshot = useEditorSnapshot(editor)
  const water = useWaterState(terrain)

  return (
    <Section icon={Droplets} title="Water" badge={water.enabled ? undefined : 'off'}>
      <Segmented
        ariaLabel="Water brush mode"
        options={MODES}
        value={snapshot.waterMode}
        onChange={(waterMode) => editor.patch({ waterMode })}
      />
      <RangeField
        label="Radius"
        value={snapshot.waterRadius}
        min={8}
        max={260}
        step={1}
        unit=" m"
        onChange={(waterRadius) => editor.patch({ waterRadius })}
      />
      <RangeField
        label="Strength"
        value={snapshot.waterStrength}
        min={0.05}
        max={1}
        step={0.05}
        onChange={(waterStrength) => editor.patch({ waterStrength })}
      />
      <div className="space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.018] p-2.5">
        <RangeField
          label="Level"
          value={water.level}
          min={-40}
          max={320}
          step={0.5}
          unit=" m"
          onChange={(level) => terrain.water.patch({ level })}
        />
        <RangeField
          label="Turbidity"
          value={water.turbidity}
          min={0}
          max={1}
          step={0.01}
          onChange={(turbidity) => terrain.water.patch({ turbidity })}
        />
        <div className="flex gap-1.5">
          <button
            type="button"
            className="panel-button flex-1"
            onClick={() => {
              const enabled = !water.enabled
              terrain.water.patch({ enabled })
              editor.patch({ status: enabled ? 'Water shown' : 'Water hidden' })
            }}
          >
            {water.enabled ? 'Hide water' : 'Show water'}
          </button>
          <button
            type="button"
            className="panel-button flex-1"
            title="Remove all standing water from the world"
            onClick={() => {
              terrain.water.clear()
              editor.patch({ status: 'World drained' })
            }}
          >
            Drain all
          </button>
        </div>
      </div>
      <p className="font-mono text-[10px] leading-relaxed text-white/28">
        Shoreline follows the ground · sculpting under water moves its edge
      </p>
    </Section>
  )
}
