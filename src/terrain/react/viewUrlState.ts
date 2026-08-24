import type { FullMaterialDebug } from '../rendering/full/createFullTerrainMaterial'
import type { TerrainRenderMode } from '../rendering/renderModes'

/**
 * Camera and UI state read from the query string.
 *
 * Visual review has to happen in the browser: the headless capture harness
 * uses a different tone mapper, a different lighting path and no streaming, so
 * a frame that looks right there proves nothing about the editor. Driving the
 * viewpoint from the URL is what makes a real-browser screenshot repeatable —
 * the same link produces the same frame on every pass.
 *
 *   ?cam=x,y,z&target=x,y,z&fov=40&quality=full&ui=off
 */
export interface ViewUrlState {
  /** Selects the editor workspace on load. */
  editor?: 'terrain' | 'tree'
  position?: [number, number, number]
  target?: [number, number, number]
  fov?: number
  quality?: TerrainRenderMode
  /** Unlit material inspection view, e.g. `?debug=albedo`. */
  debug?: FullMaterialDebug
  /** Overrides the tone-mapping exposure, for A/B grading passes. */
  exposure?: number
  /** Hides every editor panel so the frame is only the render. */
  hideUi: boolean
  /**
   * Throws away the saved world on load and rebuilds the shipped scene.
   *
   * The demo stack upgrades saved worlds by id, so authored terrain whose
   * *shape* changed under an unchanged id stays stale in any browser that has
   * seen the old one — which makes a review frame a picture of whatever that
   * profile happened to have cached rather than of the code under review.
   */
  reset: boolean
}

export function readViewUrlState(search: string): ViewUrlState {
  const params = new URLSearchParams(search)
  const quality = params.get('quality')
  const debug = params.get('debug')
  return {
    editor: parseEditor(params.get('editor')),
    position: parseVector(params.get('cam')),
    target: parseVector(params.get('target')),
    fov: parseNumber(params.get('fov')),
    quality: quality === 'full' || quality === 'preview' ? quality : undefined,
    debug: DEBUG_VIEWS.has(debug ?? '') ? (debug as FullMaterialDebug) : undefined,
    exposure: parseNumber(params.get('exposure')),
    hideUi: params.get('ui') === 'off',
    reset: params.get('reset') === '1',
  }
}

function parseEditor(value: string | null): 'terrain' | 'tree' | undefined {
  return value === 'terrain' || value === 'tree' ? value : undefined
}

const DEBUG_VIEWS = new Set<string>([
  'albedo',
  'normal',
  'relief',
  'layers',
  'strata',
  'crack',
  'blocks',
  'buttress',
  'scan',
])

export function currentViewUrlState(): ViewUrlState {
  if (typeof window === 'undefined') return { hideUi: false, reset: false }
  return readViewUrlState(window.location.search)
}

function parseVector(value: string | null): [number, number, number] | undefined {
  if (!value) return undefined
  const parts = value.split(',').map((entry) => Number(entry.trim()))
  if (parts.length !== 3 || parts.some((entry) => !Number.isFinite(entry))) {
    return undefined
  }
  return [parts[0], parts[1], parts[2]]
}

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
