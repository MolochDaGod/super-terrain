import { Box, Circle, Pill } from 'lucide-react'
import type { CsgPrimitive, EditorStore } from '../../terrain/editor/EditorStore'
import type { CsgOperation } from '../../terrain/modifiers/types'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { RangeField } from './RangeField'
import { Section } from './ui/Section'
import { Segmented, type SegmentedOption } from './ui/Segmented'

const PRIMITIVES: SegmentedOption<CsgPrimitive>[] = [
  { value: 'box', label: 'Box', icon: Box },
  { value: 'sphere', label: 'Sphere', icon: Circle },
  { value: 'capsule', label: 'Capsule', icon: Pill },
]

const OPERATIONS: SegmentedOption<CsgOperation>[] = [
  { value: 'subtract', label: 'Subtract', hint: 'Cut the volume out of the terrain' },
  { value: 'add', label: 'Add', hint: 'Union the volume into the terrain' },
]

/**
 * The recipe the next CSG volume is built from. Placing one is an Add action on
 * the toolbar; this section only decides what gets placed, which is why it
 * disappears as soon as something is selected and there is a real object to
 * show numbers for instead.
 */
export function CsgObjectsPanel({
  editor,
}: {
  editor: EditorStore
}) {
  const snapshot = useEditorSnapshot(editor)

  return (
    <Section icon={Box} title="CSG recipe" badge="next">
      <Segmented
        ariaLabel="CSG primitive"
        options={PRIMITIVES}
        value={snapshot.csgPrimitive}
        onChange={(csgPrimitive) => editor.patch({ csgPrimitive })}
      />
      <Segmented
        ariaLabel="CSG operation"
        options={OPERATIONS}
        value={snapshot.csgOperation}
        onChange={(csgOperation) => editor.patch({ csgOperation })}
      />
      <RangeField
        label="Size"
        value={snapshot.csgSize}
        min={1}
        max={96}
        step={1}
        unit=" m"
        onChange={(csgSize) => editor.patch({ csgSize })}
      />
    </Section>
  )
}
