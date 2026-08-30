import { useEffect, useRef } from 'react'
import { Info } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import { inspectorSectionForTool } from '../../terrain/editor/EditorStore'
import type { BrushDomain, PaintMode } from '../../terrain/modifiers/types'
import { BRUSH_DEPTH_PER_RADIUS } from '../../terrain/modifiers/brushKernel'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import type { ForestFieldStore } from '../../forest/ForestFieldStore'
import type { FoliageEditorStore } from '../../foliage/FoliageEditorStore'
import {
  ForestFieldPanel,
  ForestGroundCoverPanel,
} from '../../forest/react/ForestFieldPanels'
import { RangeField } from './RangeField'
import { MaterialChannelsPanel } from './MaterialChannelsPanel'
import { CsgObjectsPanel } from './CsgObjectsPanel'
import { GraniteRockPanel } from './GraniteRockPanel'
import { SelectionPanel } from './SelectionPanel'
import { WaterPanel } from './WaterPanel'
import { Section } from './ui/Section'
import { EmptyHint } from './ui/EmptyHint'
import { Segmented, type SegmentedOption } from './ui/Segmented'
import { TOOL_BY_ID } from './tools'

const BRUSH_DOMAINS: SegmentedOption<BrushDomain>[] = [
  { value: 'heightfield', label: 'Heightfield', hint: 'Deform along world Y' },
  { value: 'mesh', label: 'Mesh', hint: 'Deform along the surface normal in XYZ' },
]

type BrushBuildUp = 'stroke' | 'continuous'

const BRUSH_BUILDUP: SegmentedOption<BrushBuildUp>[] = [
  { value: 'stroke', label: 'Per stroke', hint: 'Settles on a depth; press again to build further' },
  { value: 'continuous', label: 'Continuous', hint: 'Keeps building while held; can outrun the topology' },
]

const PAINT_MODES: SegmentedOption<PaintMode>[] = [
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Erase' },
]

export function InspectorPanel({
  terrain,
  editor,
  forest,
  foliage,
}: {
  terrain: WorldTerrain
  editor: EditorStore
  forest: ForestFieldStore
  foliage: FoliageEditorStore
}) {
  const snapshot = useEditorSnapshot(editor)
  const tool = TOOL_BY_ID[snapshot.tool]

  // Switching tools reveals the section that tool works with, so the panel
  // under the parameters is always the relevant one without any scrolling.
  const previousTool = useRef(snapshot.tool)
  useEffect(() => {
    if (previousTool.current === snapshot.tool) return
    previousTool.current = snapshot.tool
    editor.patch({ openSection: inspectorSectionForTool(snapshot.tool) })
  }, [editor, snapshot.tool])

  const isSculpt = tool.kind === 'sculpt'
  const isPaint = tool.kind === 'paint'
  const hasBrush = isSculpt || isPaint
  const hasSelection = Boolean(
    snapshot.selectedRockId ?? snapshot.selectedLightId ?? snapshot.selectedModifierId,
  )
  // A viewport verb has no parameters of its own, so showing its section would
  // be a heading over an explanation and nothing else.
  // Water and forests each own their whole tool section, so the generic one
  // would only stack a second heading above them.
  const showToolSection = tool.kind !== 'viewport' && tool.kind !== 'forest'

  return (
    <aside
      aria-label="Parameters"
      className="pointer-events-auto absolute bottom-7 right-3 top-[46px] z-20 hidden w-[272px] overflow-y-auto rounded-lg border border-white/[0.09] bg-[#0b1312]/92 shadow-2xl shadow-black/30 backdrop-blur-xl md:block"
    >
      {tool.kind === 'water' && <WaterPanel terrain={terrain} editor={editor} />}
      {tool.kind === 'forest' && (
        <>
          <ForestFieldPanel forest={forest} />
          <ForestGroundCoverPanel foliage={foliage} />
        </>
      )}
      {showToolSection && tool.kind !== 'water' && (
      <Section icon={tool.icon} title={tool.label} badge={tool.shortcut}>
        <div className="flex items-start gap-2 text-[11px] leading-relaxed text-white/34">
          <Info size={12} className="mt-0.5 shrink-0 text-white/22" />
          <span>{tool.description}</span>
        </div>

        {isSculpt && (
          <Segmented
            ariaLabel="Brush domain"
            options={BRUSH_DOMAINS}
            value={snapshot.brushDomain}
            onChange={(brushDomain) =>
              editor.patch({
                brushDomain,
                status:
                  brushDomain === 'mesh'
                    ? 'Mesh brush · surface-normal XYZ deformation'
                    : 'Heightfield brush · world-Y deformation',
              })
            }
          />
        )}
        {isPaint && (
          <Segmented
            ariaLabel="Paint mode"
            options={PAINT_MODES}
            value={snapshot.paintMode}
            onChange={(paintMode) => editor.patch({ paintMode })}
          />
        )}

        {(hasBrush || snapshot.tool === 'remesh') && (
          <RangeField
            label={snapshot.tool === 'remesh' ? 'Influence' : 'Radius'}
            value={snapshot.brushRadius}
            min={4}
            max={72}
            step={1}
            unit=" m"
            onChange={(brushRadius) => editor.patch({ brushRadius })}
          />
        )}
        {hasBrush && (
          <>
            <RangeField
              label="Strength"
              // Deposition scales with the brush footprint, so the same
              // strength means different metres on different brushes. Naming
              // the depth one pass reaches saves guessing at the slider.
              hint={`≈ ${(
                snapshot.brushRadius *
                BRUSH_DEPTH_PER_RADIUS *
                snapshot.brushStrength
              ).toFixed(1)} m per pass`}
              value={snapshot.brushStrength}
              min={0.03}
              max={1}
              step={0.01}
              onChange={(brushStrength) => editor.patch({ brushStrength })}
            />
            <Segmented
              ariaLabel="Brush build-up"
              options={BRUSH_BUILDUP}
              value={snapshot.brushAccumulate ? 'continuous' : 'stroke'}
              onChange={(buildUp) =>
                editor.patch({
                  brushAccumulate: buildUp === 'continuous',
                  status: buildUp === 'continuous'
                    ? 'Continuous build-up · one stroke keeps growing while held'
                    : 'Per-stroke build-up · each press settles on a depth',
                })
              }
            />
            <RangeField
              label="Softness"
              hint={snapshot.brushFalloff < 0.08 ? 'flat disc' : undefined}
              value={snapshot.brushFalloff}
              min={0}
              max={1}
              step={0.01}
              onChange={(brushFalloff) => editor.patch({ brushFalloff })}
            />
          </>
        )}
        {snapshot.tool === 'terrace' && (
          <RangeField
            label="Step height"
            value={snapshot.terraceStep}
            min={0.5}
            max={16}
            step={0.5}
            unit=" m"
            onChange={(terraceStep) => editor.patch({ terraceStep })}
          />
        )}
        {snapshot.tool === 'noise' && (
          <RangeField
            label="Scale"
            value={snapshot.noiseScale}
            min={0.25}
            max={24}
            step={0.25}
            unit=" m"
            onChange={(noiseScale) => editor.patch({ noiseScale })}
          />
        )}
        {snapshot.tool === 'remesh' && (
          <RangeField
            label="Target edge"
            value={snapshot.targetEdgeLength}
            min={0.75}
            max={12}
            step={0.25}
            unit=" m"
            onChange={(targetEdgeLength) => editor.patch({ targetEdgeLength })}
          />
        )}
        {snapshot.tool === 'tunnel' && (
          <>
            <RangeField
              label="Portal radius"
              value={snapshot.tunnelRadius}
              min={2}
              max={128}
              step={1}
              unit=" m"
              onChange={(tunnelRadius) => editor.patch({ tunnelRadius })}
            />
            <RangeField
              label="Burial depth"
              value={snapshot.tunnelDepth}
              min={3}
              max={256}
              step={1}
              unit=" m"
              onChange={(tunnelDepth) => editor.patch({ tunnelDepth })}
            />
            <RangeField
              label="Surface noise"
              value={snapshot.tunnelNoise}
              min={0}
              max={2}
              step={0.05}
              onChange={(tunnelNoise) => editor.patch({ tunnelNoise })}
            />
            <RangeField
              label="Noise scale"
              value={snapshot.tunnelNoiseScale}
              min={0.5}
              max={32}
              step={0.5}
              unit=" m"
              onChange={(tunnelNoiseScale) => editor.patch({ tunnelNoiseScale })}
            />
          </>
        )}
        {snapshot.tool === 'dig' && (
          <>
            <RangeField
              label="Dig radius"
              value={snapshot.digRadius}
              min={1}
              max={64}
              step={0.5}
              unit=" m"
              onChange={(digRadius) => editor.patch({ digRadius })}
            />
            <RangeField
              label="Drill speed"
              value={snapshot.digSpeed}
              min={2}
              max={96}
              step={1}
              unit=" m/s"
              onChange={(digSpeed) => editor.patch({ digSpeed })}
            />
            <RangeField
              label="Surface noise"
              value={snapshot.digNoise}
              min={0}
              max={2}
              step={0.05}
              onChange={(digNoise) => editor.patch({ digNoise })}
            />
            <RangeField
              label="Noise scale"
              value={snapshot.digNoiseScale}
              min={0.5}
              max={32}
              step={0.5}
              unit=" m"
              onChange={(digNoiseScale) => editor.patch({ digNoiseScale })}
            />
          </>
        )}
      </Section>
      )}

      {isPaint && <MaterialChannelsPanel terrain={terrain} editor={editor} />}

      <SelectionPanel terrain={terrain} editor={editor} />

      {/* The granite recipe is the selected rock's parameters when there is a
          rock, and the next rock's parameters when there is not. */}
      {(snapshot.selectedRockId !== undefined || !hasSelection) && (
        <GraniteRockPanel terrain={terrain} editor={editor} />
      )}
      {!hasSelection && <CsgObjectsPanel editor={editor} />}

      {!hasSelection && !showToolSection && (
        <div className="p-3">
          <EmptyHint>
            Select something in the viewport or the scene list, and its parameters appear here.
          </EmptyHint>
        </div>
      )}
    </aside>
  )
}
