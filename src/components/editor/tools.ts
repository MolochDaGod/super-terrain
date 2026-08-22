import type { LucideIcon } from 'lucide-react'
import {
  ArrowDown,
  ArrowUp,
  CircleMinus,
  CirclePlus,
  CircleDotDashed,
  Focus,
  Grid3X3,
  Layers3,
  MousePointer2,
  Paintbrush,
  Pickaxe,
  Drill,
  Sparkles,
  Waves,
} from 'lucide-react'
import type { EditorTool } from '../../terrain/editor/EditorStore'

/** Decides which parameters the inspector shows for a tool. */
export type ToolKind = 'inspect' | 'sculpt' | 'paint' | 'topology'

export interface ToolDefinition {
  id: EditorTool
  label: string
  shortcut: string
  /** KeyboardEvent.code that selects the tool. */
  code: string
  icon: LucideIcon
  kind: ToolKind
  /** Rail rendering inserts a divider between groups. */
  group: 'primary' | 'detail' | 'paint' | 'topology'
  /** Shown on hover only; the inspector no longer prints it as body copy. */
  description: string
}

export const TOOLS: ToolDefinition[] = [
  { id: 'select', label: 'Inspect', shortcut: '1', code: 'Digit1', icon: MousePointer2, kind: 'inspect', group: 'primary', description: 'Inspect sections and select modifiers without modifying source data.' },
  { id: 'raise', label: 'Raise', shortcut: '2', code: 'Digit2', icon: ArrowUp, kind: 'sculpt', group: 'primary', description: 'Push the surface outward along its normal, or up along world Y in heightfield mode.' },
  { id: 'lower', label: 'Lower', shortcut: '3', code: 'Digit3', icon: ArrowDown, kind: 'sculpt', group: 'primary', description: 'Pull the surface inward along its normal, or down along world Y in heightfield mode.' },
  { id: 'smooth', label: 'Smooth', shortcut: '4', code: 'Digit4', icon: Waves, kind: 'sculpt', group: 'primary', description: 'Relax local detail toward the broad terrain field.' },
  { id: 'flatten', label: 'Flatten', shortcut: '5', code: 'Digit5', icon: CircleDotDashed, kind: 'sculpt', group: 'primary', description: 'Converge the surface toward the first sampled elevation.' },
  { id: 'clay', label: 'Clay', shortcut: '6', code: 'Digit6', icon: CirclePlus, kind: 'sculpt', group: 'detail', description: 'Build broad clay-like mass with a naturally flattened crest.' },
  { id: 'pinch', label: 'Pinch', shortcut: '7', code: 'Digit7', icon: Focus, kind: 'sculpt', group: 'detail', description: 'Pull the surface inward in the tangent plane to sharpen ridges and creases.' },
  { id: 'scrape', label: 'Scrape', shortcut: '8', code: 'Digit8', icon: CircleMinus, kind: 'sculpt', group: 'detail', description: 'Plane away only material above the sampled surface.' },
  { id: 'terrace', label: 'Terrace', shortcut: '9', code: 'Digit9', icon: Layers3, kind: 'sculpt', group: 'detail', description: 'Quantize elevation into editable stepped benches.' },
  { id: 'noise', label: 'Noise', shortcut: '0', code: 'Digit0', icon: Sparkles, kind: 'sculpt', group: 'detail', description: 'Stamp seeded surface breakup at a configurable world scale.' },
  { id: 'paint', label: 'Paint', shortcut: 'P', code: 'KeyP', icon: Paintbrush, kind: 'paint', group: 'paint', description: 'Paint or erase one of four material weight channels.' },
  { id: 'remesh', label: 'Density', shortcut: 'G', code: 'KeyG', icon: Grid3X3, kind: 'topology', group: 'topology', description: 'Inject local coordinate bands at the requested edge length.' },
  { id: 'tunnel', label: 'Tunnel', shortcut: 'T', code: 'KeyT', icon: Pickaxe, kind: 'topology', group: 'topology', description: 'Press one portal, drag to the second, then release. The swept Boolean stays editable in the modifier stack.' },
  { id: 'dig', label: 'Cave dig', shortcut: 'C', code: 'KeyC', icon: Drill, kind: 'topology', group: 'topology', description: 'Hold on the terrain to drill along the camera ray. Touching an existing subtractive CSG hole extends that modifier.' },
]

export const TOOL_BY_ID = Object.fromEntries(
  TOOLS.map((tool) => [tool.id, tool]),
) as Record<EditorTool, ToolDefinition>

export const TOOL_BY_KEY_CODE = Object.fromEntries(
  TOOLS.map((tool) => [tool.code, tool.id]),
) as Record<string, EditorTool | undefined>
