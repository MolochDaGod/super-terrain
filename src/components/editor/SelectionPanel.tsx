import { Combine, Move3D, Mountain, RotateCw, Scaling } from 'lucide-react'
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
import { Section } from './ui/Section'
import { Segmented, type SegmentedOption } from './ui/Segmented'
import { modifierLabel } from './modifierLabel'

const TRANSFORM_MODES: SegmentedOption<TransformMode>[] = [
  { value: 'translate', label: 'Move', icon: Move3D },
  { value: 'rotate', label: 'Rotate', icon: RotateCw },
  { value: 'scale', label: 'Scale', icon: Scaling },
]

const CSG_OPERATIONS: SegmentedOption<CsgOperation>[] = [
  { value: 'subtract', label: 'Subtract' },
  { value: 'add', label: 'Add' },
]

const DEG = 180 / Math.PI

/**
 * The one panel that reacts to selection. Nothing renders when nothing is
 * selected, and the transform mode decides which axes are shown, so the mode
 * buttons and the fields below them can never disagree.
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
  const modifier = snapshot.selectedModifierId
    ? terrain.modifiers
        .snapshot()
        .find((entry) => entry.id === snapshot.selectedModifierId)
    : undefined

  if (rock) {
    return (
      <Section icon={Mountain} title={rock.name}>
        <RockEditor terrain={terrain} editor={editor} rock={rock} mode={snapshot.transformMode} />
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

function TransformModeSwitch({
  editor,
  mode,
}: {
  editor: EditorStore
  mode: TransformMode
}) {
  return (
    <Segmented
      ariaLabel="Transform mode"
      options={TRANSFORM_MODES}
      value={mode}
      onChange={(transformMode) => editor.patch({ transformMode, tool: 'select' })}
    />
  )
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
            max={24}
            step={0.5}
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
            max={48}
            step={1}
            unit=" m"
            onChange={(depth) => {
              terrain.updateTunnelShape(modifier.id, { depth })
              editor.patch({ status: 'Tunnel shape changed · affected sections queued' })
            }}
          />
        </>
      )}

      <TransformModeSwitch editor={editor} mode={mode} />

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
  editor,
  rock,
  mode,
}: {
  terrain: WorldTerrain
  editor: EditorStore
  rock: GraniteRock
  mode: TransformMode
}) {
  const transform = rock.transform
  const apply = (next: GraniteRock['transform']) =>
    terrain.updateGraniteRockTransform(rock.id, next)
  const applyCsg = async (operation: CsgOperation) => {
    editor.patch({
      status: `Extracting ${rock.name} topology at ${rock.parameters.topologyDetail}³…`,
    })
    try {
      const modifierId = await terrain.applyGraniteRockAsCsg(rock.id, operation)
      editor.patch({
        selectedRockId: undefined,
        selectedModifierId: modifierId,
        selectedLightId: undefined,
        tool: 'select',
        status: `${rock.name} hidden · topology snapshotted as CSG ${operation}`,
      })
    } catch (error) {
      editor.patch({
        status: error instanceof Error ? error.message : 'CSG snapshot failed',
      })
    }
  }

  return (
    <>
      <TransformModeSwitch editor={editor} mode={mode} />
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
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          className="panel-button"
          data-accent="coral"
          title="Snapshot this rock's triangles as a CSG subtract; the rock is hidden, not deleted"
          onClick={() => void applyCsg('subtract')}
        >
          <Combine size={12} /> Subtract
        </button>
        <button
          type="button"
          className="panel-button"
          data-accent="mint"
          title="Snapshot this rock's triangles as a CSG union; the rock is hidden, not deleted"
          onClick={() => void applyCsg('add')}
        >
          <Combine size={12} /> Union
        </button>
      </div>
    </>
  )
}
