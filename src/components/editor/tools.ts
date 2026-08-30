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
  Hand,
  MousePointer2,
  Crosshair,
  Droplets,
  Paintbrush,
  Pickaxe,
  Drill,
  Sparkles,
  Trees,
  Waves,
} from 'lucide-react'
import type { EditorTool } from '../../terrain/editor/EditorStore'

/** Decides which parameters the inspector shows for a tool. */
export type ToolKind = 'viewport' | 'sculpt' | 'paint' | 'topology' | 'water' | 'forest'

export interface ToolDefinition {
  id: EditorTool
  label: string
  shortcut: string
  /** KeyboardEvent.code that selects the tool. */
  code: string
  icon: LucideIcon
  kind: ToolKind
  /** Rail rendering inserts a divider between groups. */
  group: 'viewport' | 'primary' | 'detail' | 'paint' | 'forest' | 'topology'
  /** Shown on hover only; the inspector no longer prints it as body copy. */
  description: string
}

export const TOOLS: ToolDefinition[] = [
  { id: 'camera', label: 'Camera', shortcut: 'Q', code: 'KeyQ', icon: Hand, kind: 'viewport', group: 'viewport', description: 'Orbit, pan and fly. Dragging moves the view and never the world.' },
  { id: 'select', label: 'Select', shortcut: '1', code: 'Digit1', icon: MousePointer2, kind: 'viewport', group: 'viewport', description: 'Click a rock, light or CSG volume to select it. Clicking bare terrain clears the selection.' },
  { id: 'cursor', label: '3D cursor', shortcut: 'X', code: 'KeyX', icon: Crosshair, kind: 'viewport', group: 'viewport', description: 'Click the terrain to place the point that Add uses. Right-click places it from any tool.' },
  { id: 'raise', label: 'Raise', shortcut: '2', code: 'Digit2', icon: ArrowUp, kind: 'sculpt', group: 'primary', description: 'Push the surface outward along its normal, or up along world Y in heightfield mode.' },
  { id: 'lower', label: 'Lower', shortcut: '3', code: 'Digit3', icon: ArrowDown, kind: 'sculpt', group: 'primary', description: 'Pull the surface inward along its normal, or down along world Y in heightfield mode.' },
  { id: 'smooth', label: 'Smooth', shortcut: '4', code: 'Digit4', icon: Waves, kind: 'sculpt', group: 'primary', description: 'Relax the surface toward the level the stroke passes over, so bumps sink and hollows fill.' },
  { id: 'flatten', label: 'Flatten', shortcut: '5', code: 'Digit5', icon: CircleDotDashed, kind: 'sculpt', group: 'primary', description: 'Converge the surface toward the first sampled elevation.' },
  { id: 'clay', label: 'Clay', shortcut: '6', code: 'Digit6', icon: CirclePlus, kind: 'sculpt', group: 'detail', description: 'Build broad clay-like mass with a naturally flattened crest.' },
  { id: 'pinch', label: 'Pinch', shortcut: '7', code: 'Digit7', icon: Focus, kind: 'sculpt', group: 'detail', description: 'Sharpen ridges and creases by exaggerating relief: what stands proud rises, what is cut sinks.' },
  { id: 'scrape', label: 'Scrape', shortcut: '8', code: 'Digit8', icon: CircleMinus, kind: 'sculpt', group: 'detail', description: 'Plane away only material above the sampled surface.' },
  { id: 'terrace', label: 'Terrace', shortcut: '9', code: 'Digit9', icon: Layers3, kind: 'sculpt', group: 'detail', description: 'Quantize elevation into editable stepped benches.' },
  { id: 'noise', label: 'Noise', shortcut: '0', code: 'Digit0', icon: Sparkles, kind: 'sculpt', group: 'detail', description: 'Blend seeded surface breakup at a configurable world scale. Depth follows the scale you set.' },
  { id: 'water', label: 'Water', shortcut: 'K', code: 'KeyK', icon: Droplets, kind: 'water', group: 'paint', description: 'Brush standing water in or out. The shoreline follows the ground, so sculpting under a lake moves its edge.' },
  { id: 'paint', label: 'Paint', shortcut: 'P', code: 'KeyP', icon: Paintbrush, kind: 'paint', group: 'paint', description: 'Paint or erase one of four material weight channels.' },
  { id: 'forest', label: 'Forest', shortcut: 'B', code: 'KeyB', icon: Trees, kind: 'forest', group: 'forest', description: 'Draw a forest as a spline on the ground. Click to drop nodes, drag a node to reshape it, then grow the field to plant it.' },
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
