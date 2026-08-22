import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  Grid3X3,
  Layers,
  Square,
  Triangle,
} from 'lucide-react'
import type { DprMode, TerrainOverlay } from '../../terrain/editor/EditorStore'
import type { TerrainRenderMode } from '../../terrain/rendering/renderModes'

/**
 * The view options, in one place.
 *
 * Render mode, resolution and overlay are each reachable from the View menu and
 * from a control pinned beside the viewport, and the two have to offer exactly
 * the same set in exactly the same order — so they read from the same list
 * rather than from two hand-kept copies.
 */

export const QUALITY_OPTIONS: {
  value: TerrainRenderMode
  label: string
  short: string
  hint: string
}[] = [
  {
    value: 'preview',
    label: 'Preview quality',
    short: 'Preview',
    hint: 'Flat-shaded materials. Fastest, and what sculpting feels best in.',
  },
  {
    value: 'full',
    label: 'Full quality',
    short: 'Full',
    hint: 'Baked procedural textures, atmosphere and water reflections.',
  },
]

export const DPR_OPTIONS: {
  value: DprMode
  label: string
  short: string
  hint: string
}[] = [
  { value: 'low', label: 'Resolution 0.75×', short: '¾×', hint: 'Three quarters of the device pixel ratio' },
  { value: 'medium', label: 'Resolution 1×', short: '1×', hint: 'One device pixel per CSS pixel' },
  { value: 'full', label: 'Resolution native', short: 'Max', hint: 'The display’s full device pixel ratio' },
]

export const OVERLAY_OPTIONS: {
  value: TerrainOverlay
  label: string
  short: string
  icon: LucideIcon
  hint: string
}[] = [
  { value: 'none', label: 'No overlay', short: 'Off', icon: Square, hint: 'The finished frame, with nothing drawn over it' },
  { value: 'sections', label: 'Section grid', short: 'Sections', icon: Grid3X3, hint: 'The streaming section each part of the terrain belongs to' },
  { value: 'lod', label: 'LOD tiers', short: 'LOD', icon: Layers, hint: 'Which detail level each section is currently meshed at' },
  { value: 'density', label: 'Triangle density', short: 'Density', icon: Triangle, hint: 'Triangles per square metre' },
  { value: 'streaming', label: 'Streaming state', short: 'Stream', icon: Activity, hint: 'Queued, compiling and resident sections' },
]
