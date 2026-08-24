import {
  normalizeTreeParameters,
  type TreeParameters,
} from './generator/types'

const DRAFT_KEY = 'meshterrain.tree-draft.v2'
const LIBRARY_KEY = 'meshterrain.tree-library.v2'

export interface SavedTreeRecipe {
  id: string
  name: string
  savedAt: string
  parameters: TreeParameters
}

export function loadTreeDraft(): TreeParameters | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const content = localStorage.getItem(DRAFT_KEY)
    if (!content) return undefined
    return normalizeTreeParameters(JSON.parse(content) as Partial<TreeParameters>)
  } catch {
    return undefined
  }
}

export function saveTreeDraft(parameters: TreeParameters): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(DRAFT_KEY, JSON.stringify(parameters))
}

/** Recipes are compact, deterministic assets that the terrain editor can regenerate. */
export function saveTreeToLibrary(parameters: TreeParameters): SavedTreeRecipe {
  const saved: SavedTreeRecipe = {
    id: `tree-${parameters.seed}-${Date.now().toString(36)}`,
    name: `${speciesName(parameters)} ${parameters.seed}`,
    savedAt: new Date().toISOString(),
    parameters: { ...parameters },
  }
  if (typeof localStorage === 'undefined') return saved
  const library = loadTreeLibrary()
  library.unshift(saved)
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(library.slice(0, 48)))
  saveTreeDraft(parameters)
  return saved
}

export function loadTreeLibrary(): SavedTreeRecipe[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const content = localStorage.getItem(LIBRARY_KEY)
    if (!content) return []
    const parsed = JSON.parse(content) as SavedTreeRecipe[]
    if (!Array.isArray(parsed)) return []
    return parsed.map((entry) => ({
      ...entry,
      parameters: normalizeTreeParameters(entry.parameters),
    }))
  } catch {
    return []
  }
}

function speciesName(parameters: TreeParameters): string {
  return parameters.species
    .split('-')
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ')
}
