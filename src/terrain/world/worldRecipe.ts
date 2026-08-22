import { DEFAULT_TERRAIN_CONFIG, type TerrainConfig } from '../config'

/**
 * What a world is made of, before anything has been edited.
 *
 * The editor can throw its document away and build a different one, so the
 * inputs that decide what a fresh document contains have to be a value that can
 * be written down, stored and replayed — not a branch buried in the terrain's
 * constructor. Everything here is either a seed or a count: there is no shape
 * data, because the shapes come from the same generators the shipped demo uses.
 */

export type WorldPreset = 'showcase' | 'wild' | 'flat'

export interface WorldRecipe {
  preset: WorldPreset
  /** Drives the height field, the outcrop sites, the river and the rocks. */
  seed: number
  /** Procedural granite outcrop patches, carved as real Boolean topology. */
  outcrops: boolean
  /** Glacial erratics planted on the surface. */
  rocks: number
  /** Whether the basin starts flooded. */
  water: boolean
}

/** The shipped demo. Its seed is authored: the composition depends on it. */
export const SHOWCASE_RECIPE: WorldRecipe = {
  preset: 'showcase',
  seed: DEFAULT_TERRAIN_CONFIG.seed,
  outcrops: true,
  rocks: 0,
  water: true,
}

export const PRESET_LABELS: Record<WorldPreset, string> = {
  showcase: 'Alpine showcase',
  wild: 'Random range',
  flat: 'Flat ground',
}

export const PRESET_DESCRIPTIONS: Record<WorldPreset, string> = {
  showcase:
    'The shipped scene: the thrust massif, its caves and windows, the outcrop field and the flooded basin.',
  wild:
    'The same generators on a new seed. Ridges, drainage, strata and outcrops are all different, and nothing is hand-placed.',
  flat:
    'A near-level plain with a couple of metres of swell. Nothing is authored into it — everything in it will be yours.',
}

export function defaultRecipeFor(preset: WorldPreset, seed: number): WorldRecipe {
  if (preset === 'showcase') return { ...SHOWCASE_RECIPE }
  if (preset === 'flat') {
    return { preset, seed, outcrops: false, rocks: 6, water: false }
  }
  return { preset, seed, outcrops: true, rocks: 10, water: true }
}

/**
 * Terrain configuration for a recipe.
 *
 * `lodDetailFocus` is deliberately dropped for generated worlds: it names the
 * coordinates of the demo's focal mountain, and holding that patch dense in a
 * world where nothing is there just spends compile time.
 */
export function terrainConfigFor(recipe: WorldRecipe): Partial<TerrainConfig> {
  return {
    seed: recipe.seed,
    worldProfile: recipe.preset === 'flat' ? 'flat' : 'natural',
    worldContent: {
      showcase: recipe.preset === 'showcase',
      outcrops: recipe.outcrops,
      rocks: recipe.rocks,
      water: recipe.water,
    },
    ...(recipe.preset === 'showcase'
      ? {}
      : { lodDetailFocus: undefined }),
  }
}

const STORAGE_KEY = 'meshterrain.world-recipe'

/**
 * The recipe survives a reload, because the generated document does not: a
 * world built from a random seed is discarded from storage when it is made, and
 * without the recipe a refresh would silently drop the user back into the demo.
 */
export function loadWorldRecipe(): WorldRecipe {
  if (typeof localStorage === 'undefined') return { ...SHOWCASE_RECIPE }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...SHOWCASE_RECIPE }
    return normalizeWorldRecipe(JSON.parse(raw) as Partial<WorldRecipe>)
  } catch {
    return { ...SHOWCASE_RECIPE }
  }
}

export function saveWorldRecipe(recipe: WorldRecipe): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recipe))
  } catch {
    // A world that cannot be remembered is still a world that can be used.
  }
}

export function normalizeWorldRecipe(value: Partial<WorldRecipe>): WorldRecipe {
  const preset: WorldPreset =
    value.preset === 'wild' || value.preset === 'flat' ? value.preset : 'showcase'
  if (preset === 'showcase') return { ...SHOWCASE_RECIPE }
  const seed = Number.isFinite(value.seed)
    ? Math.max(1, Math.floor(value.seed as number))
    : SHOWCASE_RECIPE.seed
  const fallback = defaultRecipeFor(preset, seed)
  return {
    preset,
    seed,
    outcrops: value.outcrops ?? fallback.outcrops,
    rocks: Number.isFinite(value.rocks)
      ? Math.max(0, Math.min(32, Math.floor(value.rocks as number)))
      : fallback.rocks,
    water: value.water ?? fallback.water,
  }
}
