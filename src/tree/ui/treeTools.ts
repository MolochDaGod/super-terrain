import {
  Brush,
  Eraser,
  MousePointer2,
  Sprout,
  type LucideIcon,
} from 'lucide-react'
import type { FoliageEditorStore } from '../../foliage/FoliageEditorStore'
import type { TreeEditorSnapshot, TreeEditorStore } from '../TreeEditorStore'
import type { FoliageEditorSnapshot } from '../../foliage/FoliageEditorStore'

/**
 * The four things the pointer can be doing in the forest workspace.
 *
 * There used to be no such concept. Placement lived in the tree store as an
 * "armed prototype", the ground brush lived in the foliage store as a tool, and
 * neither knew about the other — so a viewer could arm a tree and a brush at
 * once and the next click did both. Naming the mode in one place is what makes
 * the toolbar a set of radio buttons rather than a row of independent latches,
 * and it is the same shape the terrain editor's `EditorTool` already has.
 */
export type TreeWorkspaceTool = 'select' | 'place' | 'grow' | 'clear'

export interface TreeToolDefinition {
  id: TreeWorkspaceTool
  label: string
  shortcut: string
  /** KeyboardEvent.code that selects the tool. */
  code: string
  icon: LucideIcon
  /** One line, shown in the toolbar's hover card and nowhere else. */
  description: string
}

export const TREE_TOOLS: readonly TreeToolDefinition[] = [
  {
    id: 'select',
    label: 'Select',
    shortcut: '1',
    code: 'Digit1',
    icon: MousePointer2,
    description:
      'Click a tree to select it and edit the prototype every matching tree shares. Clicking bare ground clears the selection.',
  },
  {
    id: 'place',
    label: 'Plant',
    shortcut: '2',
    code: 'Digit2',
    icon: Sprout,
    description:
      'Click the ground to plant the variation armed in the catalogue. Pick a different one from the Catalogue section on the left.',
  },
  {
    id: 'grow',
    label: 'Grow',
    shortcut: '3',
    code: 'Digit3',
    icon: Brush,
    description:
      'Drag on the ground to grow the selected floor layer or plant. Right-drag still orbits the camera.',
  },
  {
    id: 'clear',
    label: 'Clear',
    shortcut: '4',
    code: 'Digit4',
    icon: Eraser,
    description:
      'Drag on the ground to thin the plants and the floor under them together.',
  },
]

export const TREE_TOOL_BY_ID = Object.fromEntries(
  TREE_TOOLS.map((tool) => [tool.id, tool]),
) as Record<TreeWorkspaceTool, TreeToolDefinition>

export const TREE_TOOL_BY_KEY_CODE = Object.fromEntries(
  TREE_TOOLS.map((tool) => [tool.code, tool.id]),
) as Record<string, TreeWorkspaceTool | undefined>

/** The mode the two stores currently add up to. */
export function activeTreeTool(
  tree: TreeEditorSnapshot,
  foliage: FoliageEditorSnapshot,
): TreeWorkspaceTool {
  if (foliage.tool === 'paint') return 'grow'
  if (foliage.tool === 'erase') return 'clear'
  return tree.armedPrototypeId ? 'place' : 'select'
}

/**
 * Puts both stores into one mode.
 *
 * Every path disarms the other store, which is the whole point: the toolbar
 * promises that exactly one thing happens when the viewport is clicked.
 */
export function setTreeWorkspaceTool(
  tree: TreeEditorStore,
  foliage: FoliageEditorStore,
  tool: TreeWorkspaceTool,
): void {
  const definition = TREE_TOOL_BY_ID[tool]
  if (tool === 'grow' || tool === 'clear') {
    tree.cancelPlacement()
    foliage.patch({
      tool: tool === 'grow' ? 'paint' : 'erase',
      status: `${definition.label} · drag on the ground, right-drag to orbit`,
    })
    return
  }

  foliage.patch({ tool: 'none' })
  if (tool === 'select') {
    tree.cancelPlacement()
    tree.patch({ status: 'Select tool active' })
    return
  }

  const snapshot = tree.getSnapshot()
  const prototypeId = snapshot.armedPrototypeId ?? snapshot.lastArmedPrototypeId
  const prototype = prototypeId ? snapshot.prototypes[prototypeId] : undefined
  if (!prototype) {
    tree.patch({ status: 'Pick a variation in the catalogue, then click the ground' })
    return
  }
  tree.armPlacement(prototype.species, prototype.variation)
}
