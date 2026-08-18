import {
  Box,
  Circle,
  Combine,
  Copy,
  Dices,
  Eye,
  EyeOff,
  Mountain,
  RectangleHorizontal,
  Trash2,
} from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type {
  EditorStore,
  TransformMode,
} from '../../terrain/editor/EditorStore'
import {
  graniteMassingOfSeed,
  graniteSeedForMassing,
  normalizeGraniteRockParameters,
  randomGraniteRockParameters,
  type GraniteMassing,
  type GraniteRock,
  type GraniteRockDetail,
  type GraniteRockParameters,
} from '../../terrain/rocks/types'
import {
  useEditorSnapshot,
  useGraniteRockRevision,
} from '../../terrain/react/hooks'
import { RangeField } from './RangeField'

const MASSINGS: Array<{
  id: GraniteMassing
  label: string
  icon: typeof Circle
}> = [
  { id: 'erratic', label: 'Erratic', icon: Circle },
  { id: 'prow', label: 'Prow', icon: Mountain },
  { id: 'arch', label: 'Arch', icon: Combine },
  { id: 'tor', label: 'Tor', icon: Box },
  { id: 'bench', label: 'Bench', icon: RectangleHorizontal },
  { id: 'monolith', label: 'Monolith', icon: Mountain },
]

export function GraniteRockPanel({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  useGraniteRockRevision(terrain)
  const snapshot = useEditorSnapshot(editor)
  const rocks = terrain.rocks.snapshot()
  const selected = snapshot.selectedRockId
    ? terrain.rocks.get(snapshot.selectedRockId)
    : undefined
  const parameters = normalizeGraniteRockParameters(
    selected?.parameters ?? snapshot.rockParameters,
  )

  const patchParameters = (next: GraniteRockParameters) => {
    const normalized = normalizeGraniteRockParameters(next)
    if (selected) terrain.updateGraniteRockParameters(selected.id, normalized)
    else editor.patch({ rockParameters: normalized })
  }
  const patchParameter = <Key extends keyof GraniteRockParameters>(
    key: Key,
    value: GraniteRockParameters[Key],
  ) => patchParameters({ ...parameters, [key]: value })
  const placementPoint = snapshot.cursorVisible
    ? snapshot.cursorPosition
    : {
        x: snapshot.cursorPosition.x,
        y: terrain.sampleHeight(
          snapshot.cursorPosition.x,
          snapshot.cursorPosition.z,
        ),
        z: snapshot.cursorPosition.z,
      }
  const addRock = (recipe: GraniteRockParameters, status: string) => {
    const id = terrain.addGraniteRock(recipe, placementPoint)
    editor.patch({
      rockParameters: { ...recipe },
      selectedRockId: id,
      selectedModifierId: undefined,
      tool: 'select',
      transformMode: 'translate',
      status,
    })
  }
  const addRandom = () => {
    const recipe = randomGraniteRockParameters(randomSeed())
    addRock(recipe, 'Random granite rock placed · translate gizmo active')
  }
  const addCurrent = () => {
    addRock(
      parameters,
      selected
        ? `${selected.name} duplicated at cursor`
        : 'Granite rock placed · translate gizmo active',
    )
  }

  return (
    <section className="border-b border-white/[0.07]">
      <header className="flex items-center justify-between px-4 pb-3 pt-4">
        <span className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/35">
          <Mountain size={12} strokeWidth={1.7} /> Granite rock lab
        </span>
        <span className="font-mono text-[8px] text-white/25">
          {rocks.length} placed
        </span>
      </header>

      <div className="space-y-3 px-3.5 pb-4">
        <div className="grid grid-cols-3 gap-1">
          {MASSINGS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              data-active={graniteMassingOfSeed(parameters.seed) === id}
              className="grid place-items-center gap-1 rounded-md border border-white/[0.07] px-1 py-2 text-[8px] transition"
              onClick={() =>
                patchParameter('seed', graniteSeedForMassing(parameters.seed, id))
              }
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>

        <div className="flex items-end gap-1.5">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-[9px] font-medium uppercase tracking-[0.12em] text-white/30">
              Deterministic seed
            </span>
            <input
              type="number"
              min={1}
              max={0x7fff_ffff}
              value={parameters.seed}
              className="h-8 w-full rounded-md border border-white/[0.08] bg-black/15 px-2 font-mono text-[10px] text-white/68"
              onChange={(event) => patchParameter('seed', Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            aria-label="Randomize current rock recipe"
            title="Randomize recipe"
            className="grid size-8 shrink-0 place-items-center rounded-md border border-white/[0.08] text-white/45 hover:bg-white/[0.05] hover:text-white/80"
            onClick={() => {
              const randomized = randomGraniteRockParameters(randomSeed())
              patchParameters({ ...randomized, detail: parameters.detail })
            }}
          >
            <Dices size={13} />
          </button>
        </div>

        <div className="space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.018] p-3">
          <RangeField label="World scale" value={parameters.placementScale} min={0.25} max={16} step={0.05} unit="×" onChange={(value) => patchParameter('placementScale', value)} />
          <RangeField label="Relief detail" value={parameters.detailStrength} min={0} max={1} step={0.01} onChange={(value) => patchParameter('detailStrength', value)} />
          <RangeField label="Wetness" value={parameters.wetness} min={0} max={1} step={0.01} onChange={(value) => patchParameter('wetness', value)} />
          <RangeField label="Lichen" value={parameters.lichen} min={0} max={1} step={0.01} onChange={(value) => patchParameter('lichen', value)} />
          <RangeField label="Moss" value={parameters.moss} min={0} max={1} step={0.01} onChange={(value) => patchParameter('moss', value)} />
          <RangeField label="Snow" value={parameters.snow} min={0} max={1} step={0.01} onChange={(value) => patchParameter('snow', value)} />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-[9px] font-medium uppercase tracking-[0.12em] text-white/30">
            <span>Source high-to-low</span>
            <span className="font-mono normal-case tracking-normal text-white/22">
              {parameters.detail === 4
                ? 'LOD0 · full atlas'
                : parameters.detail === 3
                  ? 'LOD1 · seam-safe baked surface'
                  : 'LOD2 · procedural'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/[0.07] bg-black/10 p-1">
            {([2, 3, 4] as GraniteRockDetail[]).map((detail) => (
              <button
                key={detail}
                type="button"
                data-active={parameters.detail === detail}
                className="rounded-md px-1 py-1.5 text-[8px] transition"
                onClick={() => patchParameter('detail', detail)}
              >
                {detail === 2 ? 'Draft' : detail === 3 ? 'Studio' : 'Fine'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            className="flex items-center justify-center gap-1.5 rounded-md border border-[#77e8be]/20 bg-[#77e8be]/[0.07] px-2 py-2 text-[9px] text-[#b7f6df] hover:bg-[#77e8be]/[0.12]"
            onClick={addRandom}
          >
            <Dices size={11} /> Add random
          </button>
          <button
            type="button"
            className="flex items-center justify-center gap-1.5 rounded-md border border-white/[0.09] px-2 py-2 text-[9px] text-white/55 hover:bg-white/[0.05]"
            onClick={addCurrent}
          >
            {selected ? <Copy size={11} /> : <Mountain size={11} />}
            {selected ? 'Duplicate here' : 'Add current'}
          </button>
        </div>

        <p className="text-[8px] leading-relaxed text-white/25">
          Original scifi-kit compiled topology, surface atlas, shared triplanar crystal detail, and granite biome shader.
        </p>
      </div>

      <RockList
        rocks={rocks}
        selectedId={selected?.id}
        onSelect={(rock) =>
          editor.patch({
            selectedRockId: rock.id,
            selectedModifierId: undefined,
            tool: 'select',
            status: `${rock.name} selected · edit recipe or transform`,
          })
        }
        onToggle={(rock) => terrain.setGraniteRockVisible(rock.id, !rock.visible)}
        onDelete={(rock) => {
          terrain.removeGraniteRock(rock.id)
          if (selected?.id === rock.id) editor.patch({ selectedRockId: undefined })
        }}
      />

      {selected && (
        <SelectedRockEditor
          rock={selected}
          transformMode={snapshot.transformMode}
          onTransformModeChange={(transformMode) =>
            editor.patch({ transformMode, tool: 'select' })
          }
          onTransformChange={(transform) =>
            terrain.updateGraniteRockTransform(selected.id, transform)
          }
          onApplyCsg={(operation) => {
            const modifierId = terrain.applyGraniteRockAsCsg(selected.id, operation)
            editor.patch({
              selectedRockId: undefined,
              selectedModifierId: modifierId,
              tool: 'select',
              status: `${selected.name} hidden · topology snapshotted as CSG ${operation}`,
            })
          }}
        />
      )}
    </section>
  )
}

function RockList({
  rocks,
  selectedId,
  onSelect,
  onToggle,
  onDelete,
}: {
  rocks: GraniteRock[]
  selectedId?: string
  onSelect: (rock: GraniteRock) => void
  onToggle: (rock: GraniteRock) => void
  onDelete: (rock: GraniteRock) => void
}) {
  return (
    <div className="border-t border-white/[0.06] px-3.5 py-3">
      <div className="mb-2 text-[8px] font-semibold uppercase tracking-[0.14em] text-white/28">
        Scene rocks
      </div>
      <div className="max-h-36 space-y-1 overflow-y-auto">
        {rocks.length === 0 && (
          <p className="rounded-md border border-dashed border-white/[0.08] p-3 text-[9px] text-white/28">
            No authored rocks yet. Add a random mass or tune the current recipe.
          </p>
        )}
        {rocks.map((rock) => (
          <div
            key={rock.id}
            className={`flex items-center gap-1 rounded-md border px-1.5 py-1.5 ${
              rock.id === selectedId
                ? 'border-[#77e8be]/30 bg-[#77e8be]/[0.07]'
                : 'border-white/[0.06] bg-white/[0.018]'
            }`}
          >
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(rock)}>
              <span className="block truncate text-[9px] text-white/68">{rock.name}</span>
              <span className="mt-0.5 block font-mono text-[7px] capitalize text-white/24">
                {graniteMassingOfSeed(rock.parameters.seed)} · seed {rock.parameters.seed} · LOD{4 - rock.parameters.detail}
              </span>
            </button>
            <button
              type="button"
              aria-label={rock.visible ? 'Hide rock' : 'Show rock'}
              className="grid size-6 place-items-center rounded text-white/28 hover:bg-white/[0.06] hover:text-white/70"
              onClick={() => onToggle(rock)}
            >
              {rock.visible ? <Eye size={11} /> : <EyeOff size={11} />}
            </button>
            <button
              type="button"
              aria-label="Delete rock"
              className="grid size-6 place-items-center rounded text-white/20 hover:bg-[#ff826f]/10 hover:text-[#ff826f]"
              onClick={() => onDelete(rock)}
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function SelectedRockEditor({
  rock,
  transformMode,
  onTransformModeChange,
  onTransformChange,
  onApplyCsg,
}: {
  rock: GraniteRock
  transformMode: TransformMode
  onTransformModeChange: (mode: TransformMode) => void
  onTransformChange: (transform: GraniteRock['transform']) => void
  onApplyCsg: (operation: 'subtract' | 'add') => void
}) {
  const transform = rock.transform
  return (
    <div className="space-y-3 border-t border-white/[0.06] bg-white/[0.018] px-4 py-3.5">
      <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/[0.07] bg-black/10 p-1">
        {(['translate', 'rotate', 'scale'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            data-active={transformMode === mode}
            className="rounded-md px-1 py-1.5 text-[8px] capitalize transition"
            onClick={() => onTransformModeChange(mode)}
          >
            {mode}
          </button>
        ))}
      </div>
      <RangeField
        label="Elevation"
        value={transform.position.y}
        min={-64}
        max={192}
        step={0.5}
        unit=" m"
        onChange={(value) =>
          onTransformChange({
            ...transform,
            position: { ...transform.position, y: value },
          })
        }
      />
      <RangeField
        label="Yaw"
        value={(transform.rotation.y * 180) / Math.PI}
        min={-180}
        max={180}
        step={1}
        unit="°"
        onChange={(value) =>
          onTransformChange({
            ...transform,
            rotation: { ...transform.rotation, y: (value * Math.PI) / 180 },
          })
        }
      />
      <RangeField
        label="Object scale"
        value={transform.scale}
        min={0.1}
        max={6}
        step={0.05}
        onChange={(scale) => onTransformChange({ ...transform, scale })}
      />
      <div>
        <div className="mb-2 flex items-center gap-2 text-[8px] font-semibold uppercase tracking-[0.14em] text-[#b7f6df]/55">
          <Combine size={11} /> Snapshot this topology as CSG
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            className="rounded-md border border-[#ff9d78]/20 bg-[#ff9d78]/[0.06] px-2 py-2 text-[9px] text-[#ffc0aa] hover:bg-[#ff9d78]/[0.1]"
            onClick={() => onApplyCsg('subtract')}
          >
            Subtract rock
          </button>
          <button
            type="button"
            className="rounded-md border border-[#77e8be]/20 bg-[#77e8be]/[0.06] px-2 py-2 text-[9px] text-[#b7f6df] hover:bg-[#77e8be]/[0.1]"
            onClick={() => onApplyCsg('add')}
          >
            Union rock
          </button>
        </div>
        <p className="mt-2 text-[8px] leading-relaxed text-white/24">
          The source rock is hidden, not deleted, so the cut or union stays visible. Its scene-list entry and editable recipe remain intact.
        </p>
      </div>
    </div>
  )
}

function randomSeed(): number {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]!
    return Math.max(1, value & 0x7fff_ffff)
  }
  return Math.max(1, Date.now() & 0x7fff_ffff)
}
