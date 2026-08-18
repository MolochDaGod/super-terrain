import {
  Box,
  Circle,
  Combine,
  Copy,
  Dices,
  Mountain,
  RectangleHorizontal,
} from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import {
  graniteMassingOfSeed,
  graniteSeedForMassing,
  normalizeGraniteRockParameters,
  randomGraniteRockParameters,
  type GraniteMassing,
  type GraniteRockDetail,
  type GraniteRockParameters,
  type GraniteTopologyDetail,
} from '../../terrain/rocks/types'
import {
  useEditorSnapshot,
  useGraniteRockRevision,
} from '../../terrain/react/hooks'
import { RangeField } from './RangeField'
import { CollapsibleSection } from './ui/Section'
import { Segmented, type SegmentedOption } from './ui/Segmented'
import { ListRow } from './ui/ListRow'
import { EmptyHint } from './ui/EmptyHint'

const MASSINGS: SegmentedOption<GraniteMassing>[] = [
  { value: 'erratic', label: 'Erratic', icon: Circle },
  { value: 'prow', label: 'Prow', icon: Mountain },
  { value: 'arch', label: 'Arch', icon: Combine },
  { value: 'tor', label: 'Tor', icon: Box },
  { value: 'bench', label: 'Bench', icon: RectangleHorizontal },
  { value: 'monolith', label: 'Monolith', icon: Mountain },
]

const DETAILS: SegmentedOption<`${GraniteRockDetail}`>[] = [
  { value: '2', label: 'Draft', hint: 'Render LOD2 · procedural' },
  { value: '3', label: 'Studio', hint: 'Render LOD1 · seam-safe baked surface' },
  { value: '4', label: 'Fine', hint: 'Render LOD0 · full atlas' },
]

/**
 * Grid resolution of the mesh handed to CSG. A rock scaled far up needs the
 * finest tier or its cut reads as smooth facets with no small-scale fracture.
 */
const TOPOLOGIES: SegmentedOption<`${GraniteTopologyDetail}`>[] = [
  { value: '20', label: 'Coarse', hint: '20³ grid · broad facets only, instant' },
  { value: '30', label: 'Standard', hint: '30³ grid · adds joint-plane fracture' },
  { value: '44', label: 'Fine', hint: '44³ grid · crisper facets and spall scars' },
  { value: '72', label: 'Micro', hint: '72³ grid · adds the fine worley chip band, takes seconds to extract' },
]

/** The field's finest displacement band is only resolved by the 72³ grid. */
const CHIP_BAND_CELLS = 72

export function GraniteRockPanel({
  terrain,
  editor,
  open,
  onToggle,
}: {
  terrain: WorldTerrain
  editor: EditorStore
  open: boolean
  onToggle: () => void
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

  return (
    <CollapsibleSection
      icon={Mountain}
      title="Rocks"
      badge={rocks.length}
      open={open}
      onToggle={onToggle}
    >
      <Segmented
        ariaLabel="Rock massing"
        columns={3}
        options={MASSINGS}
        value={graniteMassingOfSeed(parameters.seed)}
        onChange={(massing) =>
          patchParameter('seed', graniteSeedForMassing(parameters.seed, massing))
        }
      />

      <div className="flex gap-1.5">
        <input
          type="number"
          min={1}
          max={0x7fff_ffff}
          aria-label="Deterministic seed"
          title="Deterministic seed"
          value={parameters.seed}
          className="text-input font-mono"
          onChange={(event) => patchParameter('seed', Number(event.target.value))}
        />
        <button
          type="button"
          aria-label="Randomize recipe"
          title="Randomize recipe"
          className="panel-button shrink-0 px-2.5"
          onClick={() => {
            const randomized = randomGraniteRockParameters(randomSeed())
            patchParameters({ ...randomized, detail: parameters.detail })
          }}
        >
          <Dices size={13} />
        </button>
      </div>

      <div className="space-y-3 rounded-lg border border-white/[0.06] bg-white/[0.018] p-2.5">
        <RangeField label="World scale" value={parameters.placementScale} min={0.25} max={16} step={0.05} unit="×" onChange={(value) => patchParameter('placementScale', value)} />
        <RangeField label="Relief" value={parameters.detailStrength} min={0} max={1} step={0.01} onChange={(value) => patchParameter('detailStrength', value)} />
        <RangeField label="Wetness" value={parameters.wetness} min={0} max={1} step={0.01} onChange={(value) => patchParameter('wetness', value)} />
        <RangeField label="Lichen" value={parameters.lichen} min={0} max={1} step={0.01} onChange={(value) => patchParameter('lichen', value)} />
        <RangeField label="Moss" value={parameters.moss} min={0} max={1} step={0.01} onChange={(value) => patchParameter('moss', value)} />
        <RangeField label="Snow" value={parameters.snow} min={0} max={1} step={0.01} onChange={(value) => patchParameter('snow', value)} />
      </div>

      <Segmented
        ariaLabel="Render detail"
        options={DETAILS}
        value={`${parameters.detail}` as `${GraniteRockDetail}`}
        onChange={(detail) =>
          patchParameter('detail', Number(detail) as GraniteRockDetail)
        }
      />

      <div>
        <Segmented
          ariaLabel="CSG topology detail"
          columns={2}
          options={TOPOLOGIES}
          value={`${parameters.topologyDetail}` as `${GraniteTopologyDetail}`}
          onChange={(topologyDetail) =>
            patchParameter(
              'topologyDetail',
              Number(topologyDetail) as GraniteTopologyDetail,
            )
          }
        />
        <p className="mt-1.5 font-mono text-[10px] text-white/28">
          CSG mesh {parameters.topologyDetail}³ ·{' '}
          {parameters.topologyDetail >= CHIP_BAND_CELLS
            ? 'chip band on'
            : 'chip band off'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          className="panel-button"
          data-accent="mint"
          onClick={() =>
            addRock(
              randomGraniteRockParameters(randomSeed()),
              'Random granite rock placed · translate gizmo active',
            )
          }
        >
          <Dices size={12} /> Random
        </button>
        <button
          type="button"
          className="panel-button"
          onClick={() =>
            addRock(
              parameters,
              selected
                ? `${selected.name} duplicated at cursor`
                : 'Granite rock placed · translate gizmo active',
            )
          }
        >
          {selected ? <Copy size={12} /> : <Mountain size={12} />}
          {selected ? 'Duplicate' : 'Add current'}
        </button>
      </div>

      {rocks.length === 0 ? (
        <EmptyHint>No rocks placed yet.</EmptyHint>
      ) : (
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {rocks.map((rock) => (
            <ListRow
              key={rock.id}
              title={rock.name}
              meta={`${graniteMassingOfSeed(rock.parameters.seed)} · seed ${rock.parameters.seed}`}
              selected={rock.id === selected?.id}
              visible={rock.visible}
              onSelect={() =>
                editor.patch({
                  selectedRockId: rock.id,
                  selectedModifierId: undefined,
                  tool: 'select',
                  status: `${rock.name} selected`,
                })
              }
              onToggleVisible={() =>
                terrain.setGraniteRockVisible(rock.id, !rock.visible)
              }
              onDelete={() => {
                terrain.removeGraniteRock(rock.id)
                if (selected?.id === rock.id) {
                  editor.patch({ selectedRockId: undefined })
                }
              }}
            />
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}

function randomSeed(): number {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]!
    return Math.max(1, value & 0x7fff_ffff)
  }
  return Math.max(1, Date.now() & 0x7fff_ffff)
}
