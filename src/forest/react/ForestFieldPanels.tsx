import { Eye, EyeOff, Play, Plus, Sprout, Trash2, Trees } from 'lucide-react'
import { RangeField } from '../../components/editor/RangeField'
import { CollapsibleSection, Section } from '../../components/editor/ui/Section'
import { Segmented } from '../../components/editor/ui/Segmented'
import { EmptyHint } from '../../components/editor/ui/EmptyHint'
import { FOREST_PRESETS, type ForestPresetId } from '../../tree/forestPresets'
import type { FoliageEditorStore } from '../../foliage/FoliageEditorStore'
import { useFoliageSnapshot } from '../../foliage/react/useFoliageSnapshot'
import type { ForestFieldStore } from '../ForestFieldStore'
import { useForestFieldSnapshot } from './useForestFieldSnapshot'

/**
 * The forest tool's parameters: one field's shape and what grows in it.
 *
 * Everything here changes what the *next* grow produces, never what is standing
 * now — which is why the Grow button is part of the panel rather than something
 * that happens implicitly. A density slider that replanted two thousand stems
 * on every mouse-move would be unusable, and hiding that behind a debounce
 * would only make it unpredictable instead.
 */
export function ForestFieldPanel({ forest }: { forest: ForestFieldStore }) {
  const snapshot = useForestFieldSnapshot(forest)
  const field = snapshot.fields.find((entry) => entry.id === snapshot.selectedFieldId)
  const bake = field ? snapshot.bakes[field.id] : undefined

  return (
    <Section icon={Trees} title="Forest field" badge="B">
      {!field ? (
        <>
          <EmptyHint>
            No field selected. Draw one, then click the terrain to drop its spline
            nodes.
          </EmptyHint>
          <button
            type="button"
            className="panel-button w-full justify-center"
            data-accent="mint"
            onClick={() => forest.createField()}
          >
            <Plus size={12} /> New forest field
          </button>
        </>
      ) : (
        <>
          <div className="flex items-start gap-2 text-[11px] leading-relaxed text-white/34">
            <span>
              {snapshot.drawing
                ? 'Click the terrain to drop nodes. Enter finishes the shape.'
                : 'Drag a node to reshape. Alt-click removes one. Nothing regrows until you let go.'}
            </span>
          </div>

          <Segmented
            ariaLabel="Field shape"
            value={field.closed ? 'area' : 'belt'}
            options={[
              { value: 'area', label: 'Area', hint: 'A closed loop filled with forest' },
              { value: 'belt', label: 'Belt', hint: 'An open spline with forest either side' },
            ]}
            onChange={(shape) =>
              forest.patchField(field.id, { closed: shape === 'area' })
            }
          />

          <label className="block space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.12em] text-white/30">
              Forest type
            </span>
            <select
              className="text-input"
              value={field.preset}
              onChange={(event) =>
                forest.patchField(field.id, {
                  preset: event.target.value as ForestPresetId,
                })
              }
            >
              {FOREST_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
          </label>

          {!field.closed && (
            <RangeField
              label="Belt width"
              value={field.width}
              min={5}
              max={200}
              step={1}
              unit=" m"
              onChange={(width) => forest.patchField(field.id, { width })}
            />
          )}
          <RangeField
            label="Edge fringe"
            hint={field.feather < 12 ? 'hard edge' : undefined}
            value={field.feather}
            min={0}
            max={90}
            step={1}
            unit=" m"
            onChange={(feather) => forest.patchField(field.id, { feather })}
          />
          <RangeField
            label="Density"
            value={field.density}
            min={0.2}
            max={1.8}
            step={0.05}
            onChange={(density) => forest.patchField(field.id, { density })}
          />
          <label className="block space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.12em] text-white/30">Seed</span>
            <input
              className="text-input font-mono"
              type="number"
              min={1}
              max={0x7fffffff}
              value={field.seed}
              onChange={(event) =>
                forest.patchField(field.id, { seed: Number(event.target.value) })
              }
            />
          </label>

          <div className="grid grid-cols-[1fr_auto] gap-1.5">
            <button
              type="button"
              className="panel-button justify-center"
              data-accent="mint"
              disabled={field.nodes.length < 2}
              onClick={() => forest.requestGrow(field.id)}
            >
              <Play size={12} /> Grow field
            </button>
            <button
              type="button"
              className="icon-button size-8 border border-white/[0.07]"
              title="New forest field"
              aria-label="New forest field"
              onClick={() => forest.createField(field.preset)}
            >
              <Plus size={12} />
            </button>
          </div>
          {snapshot.drawing && (
            <button
              type="button"
              className="panel-button w-full justify-center"
              onClick={() => forest.finishDrawing()}
            >
              Finish shape
            </button>
          )}

          <label className="flex items-center justify-between gap-3 text-[11px] text-white/55">
            <span>Regrow on release</span>
            <input
              type="checkbox"
              checked={snapshot.autoGrow}
              onChange={(event) => forest.patch({ autoGrow: event.target.checked })}
            />
          </label>

          <div className="grid grid-cols-2 gap-1.5 text-[10px]">
            <Metric label="Nodes" value={field.nodes.length.toString()} />
            <Metric
              label="Stems"
              value={bake ? bake.placements.length.toString() : field.dirty ? '—' : '0'}
            />
          </div>
          {bake && (
            <p className="text-[10px] leading-relaxed text-white/28">
              Grown in {bake.elapsedMs.toFixed(0)} ms
              {field.dirty ? ' · the spline has moved since' : ''}
            </p>
          )}
        </>
      )}
    </Section>
  )
}

/**
 * The floor inside the fields, and the wind moving it.
 *
 * There is no ground-cover *brush* on this side and there should not be: the
 * splines are the record here and the mask is rasterised from them, so a
 * hand-painted stroke would be erased the next time the window recentred. What
 * is left is what genuinely belongs to the whole world — how much of it there
 * is, whether it is drawn at all, and how hard the wind is blowing.
 */
export function ForestGroundCoverPanel({
  foliage,
}: {
  foliage: FoliageEditorStore
}) {
  const snapshot = useFoliageSnapshot(foliage)
  return (
    <Section icon={Sprout} title="Ground cover">
      <RangeField
        label="Abundance"
        hint="clumps placed"
        value={snapshot.density}
        min={0.05}
        max={1}
        step={0.05}
        onChange={(density) => foliage.patch({ density })}
      />
      <RangeField
        label="Wind"
        value={snapshot.wind.strength}
        min={0}
        max={1.4}
        step={0.05}
        onChange={(strength) => foliage.patchWind({ strength })}
      />
      <RangeField
        label="Gust size"
        value={snapshot.wind.gustScale}
        min={3}
        max={60}
        step={1}
        unit=" m"
        onChange={(gustScale) => foliage.patchWind({ gustScale })}
      />
      <button
        type="button"
        className="panel-button w-full justify-center"
        aria-pressed={snapshot.visible}
        onClick={() =>
          foliage.patch({
            visible: !snapshot.visible,
            status: snapshot.visible ? 'Ground cover hidden' : 'Ground cover shown',
          })
        }
      >
        {snapshot.visible ? 'Hide ground cover' : 'Show ground cover'}
      </button>
      <p className="text-[10px] leading-relaxed text-white/28">
        The floor comes from each field's forest type and fades out across its
        fringe. The terrain shades it directly, so there is no edge to see.
      </p>
    </Section>
  )
}

/** The list of drawn forests, for the scene outliner. */
export function ForestFieldsSection({
  forest,
  open,
  onToggle,
}: {
  forest: ForestFieldStore
  open: boolean
  onToggle: () => void
}) {
  const snapshot = useForestFieldSnapshot(forest)
  const stems = Object.values(snapshot.bakes).reduce(
    (sum, bake) => sum + bake.placements.length,
    0,
  )

  return (
    <CollapsibleSection
      icon={Trees}
      title="Forests"
      badge={snapshot.fields.length > 0 ? `${snapshot.fields.length} · ${stems}` : undefined}
      open={open}
      onToggle={onToggle}
    >
      {snapshot.fields.length === 0 && (
        <EmptyHint>
          No forests drawn. Pick the Forest tool and click the terrain to lay a
          spline.
        </EmptyHint>
      )}
      {snapshot.fields.map((field) => (
        <div
          key={field.id}
          className="list-row"
          data-selected={field.id === snapshot.selectedFieldId}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => forest.selectField(field.id)}
          >
            <span className="min-w-0">
              <span className="block truncate text-[11px] text-white/72">{field.name}</span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-white/28">
                {snapshot.bakes[field.id]?.placements.length ?? 0} stems
                {field.dirty ? ' · needs growing' : ''}
              </span>
            </span>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={field.visible ? `Hide ${field.name}` : `Show ${field.name}`}
            title={field.visible ? 'Hide' : 'Show'}
            onClick={() => forest.patchField(field.id, { visible: !field.visible })}
          >
            {field.visible ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button
            type="button"
            className="icon-button"
            data-danger="true"
            aria-label={`Delete ${field.name}`}
            title="Delete"
            onClick={() => forest.removeField(field.id)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <div className="grid grid-cols-[1fr_auto] gap-1.5">
        <button
          type="button"
          className="panel-button justify-center"
          onClick={() => forest.createField()}
        >
          <Plus size={12} /> New field
        </button>
        <button
          type="button"
          className="icon-button size-8 border border-white/[0.07]"
          title="Grow every field"
          aria-label="Grow every field"
          disabled={snapshot.fields.length === 0}
          onClick={() => forest.requestGrow()}
        >
          <Play size={12} />
        </button>
      </div>
    </CollapsibleSection>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-white/[0.05] bg-black/10 p-2">
      <span className="block text-white/28">{label}</span>
      <span className="mt-1 block font-mono text-white/62">{value}</span>
    </div>
  )
}
