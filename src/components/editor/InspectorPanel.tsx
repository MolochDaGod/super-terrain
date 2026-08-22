import { useEffect, useRef } from 'react'
import { Eye, Info } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type {
  EditorStore,
  InspectorSection,
  TerrainOverlay,
} from '../../terrain/editor/EditorStore'
import { inspectorSectionForTool } from '../../terrain/editor/EditorStore'
import type { BrushDomain, PaintMode } from '../../terrain/modifiers/types'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { RangeField } from './RangeField'
import { ModifierStackPanel } from './ModifierStackPanel'
import { SculptLayersPanel } from './SculptLayersPanel'
import { MaterialChannelsPanel } from './MaterialChannelsPanel'
import { CsgObjectsPanel } from './CsgObjectsPanel'
import { GraniteRockPanel } from './GraniteRockPanel'
import { SelectionPanel } from './SelectionPanel'
import { Section, CollapsibleSection } from './ui/Section'
import { Segmented, type SegmentedOption } from './ui/Segmented'
import { TOOL_BY_ID } from './tools'
import { LightInspectorSection } from './LightInspectorSection'

const OVERLAYS: SegmentedOption<TerrainOverlay>[] = [
  { value: 'none', label: 'Clean' },
  { value: 'sections', label: 'Sections' },
  { value: 'lod', label: 'LOD' },
  { value: 'density', label: 'Density' },
  { value: 'streaming', label: 'Stream' },
]

const BRUSH_DOMAINS: SegmentedOption<BrushDomain>[] = [
  { value: 'heightfield', label: 'Heightfield', hint: 'Deform along world Y' },
  { value: 'mesh', label: 'Mesh', hint: 'Deform along the surface normal in XYZ' },
]

const PAINT_MODES: SegmentedOption<PaintMode>[] = [
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Erase' },
]

export function InspectorPanel({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  const snapshot = useEditorSnapshot(editor)
  const tool = TOOL_BY_ID[snapshot.tool]
  const selectedLight = snapshot.selectedLightId
    ? snapshot.lights.find((light) => light.id === snapshot.selectedLightId)
    : undefined

  // Switching tools reveals the section that tool works with, so the panel
  // under the parameters is always the relevant one without any scrolling.
  const previousTool = useRef(snapshot.tool)
  useEffect(() => {
    if (previousTool.current === snapshot.tool) return
    previousTool.current = snapshot.tool
    editor.patch({ openSection: inspectorSectionForTool(snapshot.tool) })
  }, [editor, snapshot.tool])

  const toggle = (section: InspectorSection) =>
    editor.patch({
      openSection: snapshot.openSection === section ? undefined : section,
    })
  const sectionProps = (section: InspectorSection) => ({
    open: snapshot.openSection === section,
    onToggle: () => toggle(section),
  })

  const isSculpt = tool.kind === 'sculpt'
  const isPaint = tool.kind === 'paint'
  const hasBrush = isSculpt || isPaint

  return (
    <aside className="pointer-events-auto absolute bottom-9 right-3 top-[68px] z-20 hidden w-[268px] overflow-y-auto rounded-xl border border-white/[0.09] bg-[#0b1312]/92 shadow-2xl shadow-black/30 backdrop-blur-xl md:block">
      {selectedLight ? (
        <LightInspectorSection light={selectedLight} editor={editor} />
      ) : (
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
              value={snapshot.brushStrength}
              min={0.03}
              max={1}
              step={0.01}
              onChange={(brushStrength) => editor.patch({ brushStrength })}
            />
            <RangeField
              label="Falloff"
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

      <SelectionPanel terrain={terrain} editor={editor} />

      <SculptLayersPanel terrain={terrain} editor={editor} {...sectionProps('layers')} />
      <MaterialChannelsPanel terrain={terrain} editor={editor} {...sectionProps('materials')} />
      <GraniteRockPanel terrain={terrain} editor={editor} {...sectionProps('rocks')} />
      <CsgObjectsPanel terrain={terrain} editor={editor} {...sectionProps('csg')} />
      <ModifierStackPanel terrain={terrain} editor={editor} {...sectionProps('modifiers')} />

      <CollapsibleSection
        icon={Eye}
        title="Display"
        badge={OVERLAYS.find((entry) => entry.value === snapshot.overlay)?.label}
        {...sectionProps('display')}
      >
        <Segmented
          ariaLabel="Terrain overlay"
          columns={3}
          options={OVERLAYS}
          value={snapshot.overlay}
          onChange={(overlay) => {
            editor.patch({ overlay })
            terrain.setOverlay(overlay)
          }}
        />
      </CollapsibleSection>
    </aside>
  )
}
