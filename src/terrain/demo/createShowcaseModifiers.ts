import type { TerrainModifier } from '../modifiers/types'
import {
  OUTCROP_ID_PREFIX,
  SUPERSEDED_OUTCROP_PREFIXES,
  createOutcropFieldModifiers,
} from './createOutcropField'
import {
  THRUST_MODIFIER_IDS,
  createThrustFormationModifiers,
} from './createThrustFormation'

/**
 * Authored mesh-terrain patch set shipped with the cinematic scene.
 *
 * The central shard and every surrounding outcrop are mesh operands compiled
 * into the terrain sections themselves. They are deliberately not React props
 * placed over a procedural ground plane: Boolean union makes their fractured
 * triangles part of the streamed, editable terrain surface, while the two
 * windows are real subtractive topology through that surface.
 */
export function createShowcaseTerrainModifiers(seed: number): TerrainModifier[] {
  const [thrustMass, thrustPartings, thrustWindows] = createThrustFormationModifiers()
  if (!thrustMass || !thrustPartings || !thrustWindows) {
    throw new Error('The authored thrust stack requires mass, parting, and window modifiers')
  }
  return [
    thrustMass,
    thrustPartings,
    ...createOutcropFieldModifiers(seed),
    // Root patches intentionally overlap the landmark so it grows out of the
    // basin. Carve the natural granite windows last; otherwise those later
    // unions refill the passages even though the isolated thrust test passes.
    thrustWindows,
  ]
}

const SUPERSEDED_SHOWCASE_PREFIXES = [
  'showcase-v1-',
  'showcase-v2-',
  'showcase-v3-',
  'showcase-v4-',
  'showcase-v5-',
  'showcase-v6-',
  'showcase-v7-',
  'showcase-v8-',
  'showcase-v9-',
  'showcase-v10-',
  'showcase-v11-',
  'showcase-v12-',
]

/** Replaces superseded showcase generations without touching user edits. */
export function upgradeShowcaseTerrainModifiers(
  modifiers: readonly TerrainModifier[],
  seed: number,
): TerrainModifier[] | undefined {
  const hasSuperseded = modifiers.some((modifier) =>
    SUPERSEDED_SHOWCASE_PREFIXES.some((prefix) => modifier.id.startsWith(prefix)),
  )
  const currentIds = new Set<string>(THRUST_MODIFIER_IDS)
  const presentCurrentIds = new Set(
    modifiers
      .map((modifier) => modifier.id)
      .filter((id) => currentIds.has(id)),
  )
  const hasAnyCurrent = presentCurrentIds.size > 0
  const hasAllCurrent = presentCurrentIds.size === currentIds.size
  if (!hasSuperseded && hasAllCurrent) return undefined
  if (!hasSuperseded && !hasAnyCurrent) return undefined
  const shippedOutcropPrefixes = [
    ...SUPERSEDED_OUTCROP_PREFIXES,
    OUTCROP_ID_PREFIX,
  ]
  const retained = modifiers.filter(
    (modifier) =>
      !currentIds.has(modifier.id) &&
      !SUPERSEDED_SHOWCASE_PREFIXES.some(
        (prefix) => modifier.id.startsWith(prefix),
      ) &&
      !shippedOutcropPrefixes.some(
        (prefix) => modifier.id.startsWith(prefix),
      ),
  )
  return [...retained, ...createShowcaseTerrainModifiers(seed)]
}
