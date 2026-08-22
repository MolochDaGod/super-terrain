import {
  Box,
  Circle,
  Combine,
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
import { randomSeed } from './editorActions'
import { RangeField } from './RangeField'
import { Section } from './ui/Section'
import { Segmented, type SegmentedOption } from './ui/Segmented'

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

/**
 * Granite parameters.
 *
 * Dual-purpose by design: with a rock selected it edits that rock, and with
 * nothing selected it is the recipe the next one is built from. Both are the
 * same set of numbers, and splitting them into two panels would only make the
 * user learn which of the two they were looking at.
 */
export function GraniteRockPanel({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  useGraniteRockRevision(terrain)
  const snapshot = useEditorSnapshot(editor)
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

  return (
    <Section
      icon={Mountain}
      // The selection section above already names the rock, so this one names
      // what it actually contains rather than repeating the heading.
      title={selected ? 'Granite surface' : 'Rock recipe'}
      badge={selected ? undefined : 'next'}
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

    </Section>
  )
}
