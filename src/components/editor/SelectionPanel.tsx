import { Move3D, Mountain } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type {
  EditorStore,
  TransformMode,
} from '../../terrain/editor/EditorStore'
import type { CsgOperation } from '../../terrain/modifiers/types'
import type { GraniteRock } from '../../terrain/rocks/types'
import type { ModifierTransform, TerrainModifier } from '../../terrain/modifiers/types'
import { normalizedTransform } from '../../terrain/modifiers/transform'
import {
  useEditorSnapshot,
  useGraniteRockRevision,
  useModifierRevision,
} from '../../terrain/react/hooks'
import { RangeField } from './RangeField'
import { LightInspectorSection } from './LightInspectorSection'
import { Section } from './ui/Section'
import { Segmented, type SegmentedOption } from './ui/Segmented'
import { modifierLabel } from './modifierLabel'

const CSG_OPERATIONS: SegmentedOption<CsgOperation>[] = [
  { value: 'subtract', label: 'Subtract' },
  { value: 'add', label: 'Add' },
]

const DEG = 180 / Math.PI

/**
 * The one panel that reacts to selection. Nothing renders when nothing is
 * selected, and the transform mode — set on the object toolbar — decides which
 * axes are shown, so the toolbar and the fields below can never disagree.
 */
export function SelectionPanel({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  useModifierRevision(terrain)
  useGraniteRockRevision(terrain)
  const snapshot = useEditorSnapshot(editor)

  const rock = snapshot.selectedRockId
    ? terrain.rocks.get(snapshot.selectedRockId)
    : undefined
  const light = snapshot.selectedLightId
    ? snapshot.lights.find((entry) => entry.id === snapshot.selectedLightId)
    : undefined
  const modifier = snapshot.selectedModifierId
    ? terrain.modifiers
        .snapshot()
        .find((entry) => entry.id === snapshot.selectedModifierId)
    : undefined

  if (light) return <LightInspectorSection light={light} editor={editor} />
  if (rock) {
    return (
      <Section icon={Mountain} title={rock.name}>
        <RockEditor terrain={terrain} rock={rock} mode={snapshot.transformMode} />
      </Section>
    )
  }
  if (modifier) {
    return (
      <Section icon={Move3D} title={modifierLabel(modifier)}>
        <ModifierEditor
          terrain={terrain}
          editor={editor}
          modifier={modifier}
          mode={snapshot.transformMode}
        />
      </Section>
    )
  }
  return null
}

function ModifierEditor({
  terrain,
  editor,
  modifier,
  mode,
}: {
  terrain: WorldTerrain
  editor: EditorStore
  modifier: TerrainModifier
  mode: TransformMode
}) {
  const transform = normalizedTransform(modifier.transform)
  const apply = (next: ModifierTransform) => {
    terrain.updateModifierTransform(modifier.id, next)
    editor.patch({ status: 'Modifier transformed · affected sections queued' })
  }
  const patchOffset = (axis: 'x' | 'y' | 'z', value: number) =>
    apply({ ...transform, offset: { ...transform.offset, [axis]: value } })

  return (
    <>
      {modifier.type === 'boolean-volume' && (
        <Segmented
          ariaLabel="CSG operation"
          options={CSG_OPERATIONS}
          value={modifier.operation}
          onChange={(operation) => {
            terrain.updateCsgOperation(modifier.id, operation)
            editor.patch({ status: `CSG ${operation} queued` })
          }}
        />
      )}
      {modifier.type === 'boolean-subtract' && (
        <>
          <RangeField
            label="Portal radius"
            value={modifier.radius}
            min={2}
            max={128}
            step={1}
            unit=" m"
            onChange={(radius) => {
              terrain.updateTunnelShape(modifier.id, { radius })
              editor.patch({ status: 'Tunnel shape changed · affected sections queued' })
            }}
          />
          <RangeField
            label="Burial depth"
            value={modifier.depth}
            min={3}
            max={256}
            step={1}
            unit=" m"
            onChange={(depth) => {
              terrain.updateTunnelShape(modifier.id, { depth })
              editor.patch({ status: 'Tunnel shape changed · affected sections queued' })
            }}
          />
          <RangeField
            label="Surface noise"
            value={modifier.noise}
            min={0}
            max={2}
            step={0.05}
            onChange={(noise) => {
              terrain.updateTunnelShape(modifier.id, { noise })
              editor.patch({ status: 'Tunnel noise changed · affected sections queued' })
            }}
          />
          <RangeField
            label="Noise scale"
            value={modifier.noiseScale}
            min={0.5}
            max={32}
            step={0.5}
            unit=" m"
            onChange={(noiseScale) => {
              terrain.updateTunnelShape(modifier.id, { noiseScale })
              editor.patch({ status: 'Tunnel noise scale changed · affected sections queued' })
            }}
          />
        </>
      )}

      {mode === 'translate' && (
        <>
          <RangeField label="X" value={transform.offset.x} min={-128} max={128} step={1} unit=" m" onChange={(value) => patchOffset('x', value)} />
          <RangeField label="Y" value={transform.offset.y} min={-96} max={96} step={1} unit=" m" onChange={(value) => patchOffset('y', value)} />
          <RangeField label="Z" value={transform.offset.z} min={-128} max={128} step={1} unit=" m" onChange={(value) => patchOffset('z', value)} />
        </>
      )}
      {mode === 'rotate' && (
        <>
          <RangeField label="Yaw" value={transform.yaw * DEG} min={-180} max={180} step={1} unit="°" onChange={(value) => apply({ ...transform, yaw: value / DEG })} />
          <RangeField label="Pitch" value={(transform.pitch ?? 0) * DEG} min={-180} max={180} step={1} unit="°" onChange={(value) => apply({ ...transform, pitch: value / DEG })} />
          <RangeField label="Roll" value={(transform.roll ?? 0) * DEG} min={-180} max={180} step={1} unit="°" onChange={(value) => apply({ ...transform, roll: value / DEG })} />
        </>
      )}
      {mode === 'scale' && (
        <RangeField label="Scale" value={transform.scale} min={0.25} max={4} step={0.05} unit="×" onChange={(scale) => apply({ ...transform, scale })} />
      )}
    </>
  )
}

function RockEditor({
  terrain,
  rock,
  mode,
}: {
  terrain: WorldTerrain
  rock: GraniteRock
  mode: TransformMode
}) {
  const transform = rock.transform
  const apply = (next: GraniteRock['transform']) =>
    terrain.updateGraniteRockTransform(rock.id, next)

  return (
    <>
      {mode === 'translate' && (
        <RangeField
          label="Elevation"
          value={transform.position.y}
          min={-64}
          max={192}
          step={0.5}
          unit=" m"
          onChange={(value) =>
            apply({ ...transform, position: { ...transform.position, y: value } })
          }
        />
      )}
      {mode === 'rotate' && (
        <RangeField
          label="Yaw"
          value={transform.rotation.y * DEG}
          min={-180}
          max={180}
          step={1}
          unit="°"
          onChange={(value) =>
            apply({
              ...transform,
              rotation: { ...transform.rotation, y: value / DEG },
            })
          }
        />
      )}
      {mode === 'scale' && (
        <>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <RangeField
              key={axis}
              label={axis.toUpperCase()}
              value={transform.scale[axis]}
              min={0.1}
              max={6}
              step={0.05}
              unit="×"
              onChange={(value) =>
                apply({ ...transform, scale: { ...transform.scale, [axis]: value } })
              }
            />
          ))}
          <button
            type="button"
            className="panel-button"
            title="Match Y and Z to X"
            onClick={() =>
              apply({
                ...transform,
                scale: {
                  x: transform.scale.x,
                  y: transform.scale.x,
                  z: transform.scale.x,
                },
              })
            }
          >
            Make uniform
          </button>
        </>
      )}
    </>
  )
}
