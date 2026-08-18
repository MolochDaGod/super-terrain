import type { AABB, Vec3Like } from '../core/types'

export type GraniteMassing =
  | 'erratic'
  | 'prow'
  | 'arch'
  | 'tor'
  | 'bench'
  | 'monolith'
export type GraniteRockDetail = 2 | 3 | 4
export type GraniteSourceSeed = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** The source asset's LOD2, LOD1, and production LOD0 dual-contour grids. */
export const GRANITE_DETAIL_CELLS: Record<GraniteRockDetail, number> = {
  2: 20,
  3: 30,
  4: 44,
}

export interface GraniteRockParameters {
  seed: number
  /** Independent material variation; does not alter CSG topology. */
  surfaceSeed: number
  /** Uniform runtime scale applied after the source's metre conversion. */
  placementScale: number
  snow: number
  wetness: number
  lichen: number
  moss: number
  detailStrength: number
  detail: GraniteRockDetail
}

export interface GraniteRockTransform {
  position: Vec3Like
  rotation: Vec3Like
  scale: number
}

export interface GraniteRock {
  id: string
  name: string
  visible: boolean
  parameters: GraniteRockParameters
  transform: GraniteRockTransform
}

export interface GraniteRockMesh {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  indices: Uint32Array
  bounds: AABB
}

export const DEFAULT_GRANITE_ROCK_PARAMETERS: GraniteRockParameters = {
  seed: 1,
  surfaceSeed: 1,
  placementScale: 4,
  snow: 0,
  wetness: 0.12,
  lichen: 0.16,
  moss: 0.06,
  detailStrength: 0.72,
  detail: 3,
}

export function graniteMassingPreset(
  massing: GraniteMassing,
  seed = DEFAULT_GRANITE_ROCK_PARAMETERS.seed,
  detail: GraniteRockDetail = DEFAULT_GRANITE_ROCK_PARAMETERS.detail,
): GraniteRockParameters {
  return {
    ...DEFAULT_GRANITE_ROCK_PARAMETERS,
    seed: graniteSeedForMassing(seed, massing),
    surfaceSeed: graniteSeedForMassing(seed, massing),
    detail,
  }
}

export function normalizeGraniteRockParameters(
  parameters: Partial<GraniteRockParameters> | undefined,
): GraniteRockParameters {
  const legacy = parameters as LegacyGraniteRockParameters | undefined
  let seed = normalizeSeed(parameters?.seed ?? DEFAULT_GRANITE_ROCK_PARAMETERS.seed)
  if (parameters?.placementScale === undefined && legacy?.massing !== undefined) {
    seed = graniteSeedForMassing(seed, normalizeGraniteMassing(legacy.massing))
  }
  const detail = parameters?.detail === 2 || parameters?.detail === 4
    ? parameters.detail
    : 3
  return {
    seed,
    surfaceSeed: normalizeSeed(parameters?.surfaceSeed ?? seed),
    placementScale: clampFinite(
      parameters?.placementScale,
      legacyScale(legacy?.size),
      0.1,
      64,
    ),
    snow: clampFinite(parameters?.snow, DEFAULT_GRANITE_ROCK_PARAMETERS.snow, 0, 1),
    wetness: clampFinite(parameters?.wetness, DEFAULT_GRANITE_ROCK_PARAMETERS.wetness, 0, 1),
    lichen: clampFinite(parameters?.lichen, DEFAULT_GRANITE_ROCK_PARAMETERS.lichen, 0, 1),
    moss: clampFinite(parameters?.moss, DEFAULT_GRANITE_ROCK_PARAMETERS.moss, 0, 1),
    detailStrength: clampFinite(
      parameters?.detailStrength ?? legacy?.roughness,
      DEFAULT_GRANITE_ROCK_PARAMETERS.detailStrength,
      0,
      1,
    ),
    detail,
  }
}

export function randomGraniteRockParameters(seed: number): GraniteRockParameters {
  const normalizedSeed = normalizeSeed(seed)
  return normalizeGraniteRockParameters({
    seed: normalizedSeed,
    surfaceSeed: normalizeSeed(normalizedSeed + 10_007),
    placementScale: snapHundredth(2.8 + randomUnit(normalizedSeed, 2) * 3.4),
    wetness: snapHundredth(0.05 + randomUnit(normalizedSeed, 3) * 0.24),
    lichen: snapHundredth(0.06 + randomUnit(normalizedSeed, 4) * 0.28),
    moss: snapHundredth(0.02 + randomUnit(normalizedSeed, 5) * 0.14),
    snow: 0,
    detailStrength: snapHundredth(0.62 + randomUnit(normalizedSeed, 6) * 0.28),
    detail: 3,
  })
}

export function cloneGraniteRock(rock: GraniteRock): GraniteRock {
  return {
    ...rock,
    parameters: { ...rock.parameters },
    transform: {
      ...rock.transform,
      position: { ...rock.transform.position },
      rotation: { ...rock.transform.rotation },
    },
  }
}

export function normalizeGraniteRockTransform(
  transform: Partial<GraniteRockTransform> | undefined,
): GraniteRockTransform {
  return {
    position: {
      x: finiteOr(transform?.position?.x, 0),
      y: finiteOr(transform?.position?.y, 0),
      z: finiteOr(transform?.position?.z, 0),
    },
    rotation: {
      x: finiteOr(transform?.rotation?.x, 0),
      y: finiteOr(transform?.rotation?.y, 0),
      z: finiteOr(transform?.rotation?.z, 0),
    },
    scale: clampFinite(transform?.scale, 1, 0.05, 64),
  }
}

export function graniteRockParameterKey(parameters: GraniteRockParameters): string {
  const normalized = normalizeGraniteRockParameters(parameters)
  return [
    graniteRockTopologyKey(normalized),
    normalized.surfaceSeed,
    normalized.snow.toFixed(4),
    normalized.wetness.toFixed(4),
    normalized.lichen.toFixed(4),
    normalized.moss.toFixed(4),
    normalized.detailStrength.toFixed(4),
  ].join(':')
}

export function graniteRockTopologyKey(parameters: GraniteRockParameters): string {
  const normalized = normalizeGraniteRockParameters(parameters)
  return [
    graniteSourceSeed(normalized.seed),
    normalized.placementScale.toFixed(4),
    normalized.detail,
  ].join(':')
}

const GRANITE_MASSINGS: readonly GraniteMassing[] = [
  'erratic',
  'prow',
  'arch',
  'tor',
  'bench',
  'monolith',
]

export function graniteMassingOfSeed(seed: number): GraniteMassing {
  return GRANITE_MASSINGS[(normalizeSeed(seed) - 1) % GRANITE_MASSINGS.length]!
}

/** Source-compiled archetype carrying the matching topology and surface atlas. */
export function graniteSourceSeed(seed: number): GraniteSourceSeed {
  const normalized = normalizeSeed(seed)
  const formationSeed = ((normalized - 1) % GRANITE_MASSINGS.length) + 1
  if (formationSeed === 1 && Math.floor((normalized - 1) / 6) % 2 === 1) return 7
  return formationSeed as GraniteSourceSeed
}

export function graniteSeedForMassing(seed: number, massing: GraniteMassing): number {
  const normalized = normalizeSeed(seed)
  const cycle = Math.floor((normalized - 1) / GRANITE_MASSINGS.length)
  return cycle * GRANITE_MASSINGS.length + GRANITE_MASSINGS.indexOf(massing) + 1
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 1
  return Math.max(1, Math.min(0x7fff_ffff, Math.floor(Math.abs(seed))))
}

function normalizeGraniteMassing(value: unknown): GraniteMassing {
  if (
    value === 'erratic' ||
    value === 'prow' ||
    value === 'arch' ||
    value === 'tor' ||
    value === 'bench' ||
    value === 'monolith'
  ) {
    return value
  }
  // Existing local saves used the first lightweight generator's four presets.
  if (value === 'rounded') return 'erratic'
  if (value === 'block') return 'tor'
  if (value === 'slab') return 'bench'
  if (value === 'spire') return 'monolith'
  return graniteMassingOfSeed(DEFAULT_GRANITE_ROCK_PARAMETERS.seed)
}

interface LegacyGraniteRockParameters {
  massing?: unknown
  size?: Partial<Vec3Like>
  roughness?: number
}

function legacyScale(size: Partial<Vec3Like> | undefined): number {
  if (!size) return DEFAULT_GRANITE_ROCK_PARAMETERS.placementScale
  const x = finiteOr(size.x, 3.64) / 3.64
  const y = finiteOr(size.y, 3.24) / 3.24
  const z = finiteOr(size.z, 3.4) / 3.4
  return (x + y + z) / 3
}

function clampFinite(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, finiteOr(value, fallback)))
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback
}

function randomUnit(seed: number, salt: number): number {
  let value = Math.imul(seed ^ Math.imul(salt, 0x9e37_79b1), 0x85eb_ca6b)
  value ^= value >>> 13
  value = Math.imul(value, 0xc2b2_ae35)
  value ^= value >>> 16
  return (value >>> 0) / 0x1_0000_0000
}

function snapHundredth(value: number): number {
  return Math.round(value * 100) / 100
}
