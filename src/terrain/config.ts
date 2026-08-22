import type { WorldProfile } from './compiler/heightField'

export interface TerrainConfig {
  worldSize: number
  sectionSize: number
  lodResolutions: readonly number[]
  operationHalo: number
  workerCount: number
  targetFps: number
  baseLodErrorPixels: number
  /** Finest-detail editing patch around the camera's terrain section. */
  lod0FocusRadiusSections: number
  /** Optional world-space focal region that retains authored presentation detail. */
  lodDetailFocus?: TerrainLodDetailFocus
  renderRadiusSections: number
  maxRenderRadiusSections: number
  prefetchSections: number
  maxGpuBytes: number
  maxCpuCompiledBytes: number
  maxEditableMeshBytes: number
  maxUploadsPerFrame: number
  maxUploadBytesPerFrame: number
  maxSectionSwapsPerFrame: number
  terrainCpuBudgetMs: number
  sectionRetentionMs: number
  seed: number
  /** Landform model the world is built from. See `setWorldProfile`. */
  worldProfile: WorldProfile
  /** What is authored into a document that has never been edited. */
  worldContent: WorldContent
}

/** The generated content of a fresh document. See `WorldRecipe`. */
export interface WorldContent {
  /** The hand-composed demo massif, its caves and its baked sections. */
  showcase: boolean
  /** Seeded granite outcrop patches. */
  outcrops: boolean
  /** Number of glacial erratics planted on the surface. */
  rocks: number
  /** Whether the basin starts flooded. */
  water: boolean
}

export interface TerrainLodDetailFocus {
  x: number
  z: number
  /** Radius whose sections retain `finestLod`, with one LOD step per outer ring. */
  radiusSections: number
  finestLod: number
}

const availableWorkers =
  typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency ?? 4

/**
 * Terrain compilation is embarrassingly parallel across sections, but using
 * every logical core makes camera input and WebGPU command submission compete
 * with the workers. Keep roughly one quarter of the machine available and cap
 * the pool to avoid excessive per-worker module and scratch-memory overhead.
 */
export function recommendedTerrainWorkerCount(logicalCores: number): number {
  const cores = Number.isFinite(logicalCores)
    ? Math.max(1, Math.floor(logicalCores))
    : 4
  return Math.max(2, Math.min(6, Math.floor(cores * 0.66)))
}

export const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  // 4 km x 4 km. The demo world only ever authors and renders the massif
  // around the origin, and a 16 km logical extent bought nothing for it: the
  // far-field proxy mesh scaled with the square of the world size, the horizon
  // residency mask grew with it, and every metre past the haze horizon is
  // invisible anyway. Four kilometres still puts the far ridges beyond where
  // aerial perspective has dissolved them.
  worldSize: 4_096,
  sectionSize: 128,
  // The finest resolution creates the authoritative section mesh. Coarser
  // values define QEM triangle-count targets; borders and authored features
  // remain locked, so a level may deliberately retain more triangles than its
  // nominal target. The texture-normal path carries the centimetre detail, so
  // spending source triangles below ~1.8 m only slows compilation and does not
  // improve the finished frame.
  lodResolutions: [88, 44, 22, 11, 6],
  operationHalo: 12,
  workerCount: recommendedTerrainWorkerCount(availableWorkers),
  targetFps: 30,
  baseLodErrorPixels: 2.65,
  // Screen-error LOD alone demotes nearby terrain while the camera is elevated.
  // Keep a 3x3 authoring patch under the camera genuinely at LOD0.
  lod0FocusRadiusSections: 1.35,
  // The shipped composition places its rear massif roughly 800 m from the
  // camera. Pure screen-error selection legitimately chose a six-sample source
  // grid there, but that made the largest background form visibly faceted.
  // Keep the focal mountain dense without raising detail across the whole 4 km
  // world; its authored 29 m fracture cells resolve at LOD1, and finer surface
  // response comes from the PBR scan rather than another 150k smooth triangles.
  lodDetailFocus: {
    x: 420,
    z: 395,
    radiusSections: 1.5,
    finestLod: 1,
  },
  // The far-field proxy already carries the horizon. Keep only the nearest
  // kilometre of editable sections resident at launch; the projected-view
  // calculation still expands this radius automatically when the camera pulls
  // back. A radius of ten forced ~120 extra worker compiles before the initial
  // editor view could settle without improving anything visible in that view.
  renderRadiusSections: 4,
  maxRenderRadiusSections: 14,
  prefetchSections: 0,
  maxGpuBytes: 256 * 1024 * 1024,
  maxCpuCompiledBytes: 384 * 1024 * 1024,
  maxEditableMeshBytes: 192 * 1024 * 1024,
  maxUploadsPerFrame: 2,
  maxUploadBytesPerFrame: 6 * 1024 * 1024,
  maxSectionSwapsPerFrame: 2,
  terrainCpuBudgetMs: 1.5,
  sectionRetentionMs: 12_000,
  seed: 13_371,
  worldProfile: 'natural',
  worldContent: { showcase: true, outcrops: true, rocks: 0, water: true },
}
