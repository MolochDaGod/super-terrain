/**
 * `preview` is the responsive editing look: flat lighting, vertex colours, no
 * per-pixel surface synthesis. `full` turns on the complete shading pipeline
 * (layered procedural materials, parallax micro-relief, atmosphere).
 */
export type TerrainRenderMode = 'preview' | 'full'

export const TERRAIN_RENDER_MODES: readonly TerrainRenderMode[] = ['preview', 'full']

export const RENDER_MODE_LABELS: Record<TerrainRenderMode, string> = {
  preview: 'Preview',
  full: 'Full',
}
