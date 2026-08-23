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
  /**
   * Ceiling on how many sections may be resident at once. Residency reaches
   * across the whole world where the world is small enough to fit under this;
   * past it the far-field proxy takes over again. See
   * `recommendedResidencyRadiusSections`.
   */
  maxResidentSections: number
  prefetchSections: number
  maxGpuBytes: number
  maxCpuCompiledBytes: number
  maxEditableMeshBytes: number
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

/**
 * Residency radius, in sections, for a world of this size.
 *
 * Terrain used to exist only in a small disc around the camera, with a single
 * coarse proxy mesh standing in for the entire rest of the map. That disc was
 * sized from the projected viewport footprint, which is a reasonable rule for
 * deciding *detail* and a poor one for deciding *existence*: it left five LOD
 * levels selecting between each other inside one kilometre while everything
 * beyond was one flat approximation with its own colours and its own silhouette.
 *
 * The measured cost of the levels this actually adds is what makes reaching the
 * world edge the better default. Past roughly 520 m the screen-error rule picks
 * the coarsest level for everything, and a section there compiles in 1.2 ms and
 * occupies 5 KB with 72 source triangles. Holding the entire shipped 4 km world
 * is about 1,000 sections, 13 MB and 210k triangles -- less geometry than the
 * old disc was already drawing, because the disc spent its budget on levels
 * that were finer than the distance justified.
 *
 * The section ceiling is what keeps this honest for a world too large to hold.
 * A 16 km world is 16,384 sections and does not fit; there the radius falls back
 * to what does fit and the proxy resumes its original job beyond it.
 */
export function recommendedResidencyRadiusSections(
  worldSize: number,
  sectionSize: number,
  maxResidentSections: number,
): number {
  const sectionsPerAxis = Math.max(1, Math.ceil(worldSize / sectionSize))
  // Worst case the camera sits in a corner, so covering the world means
  // reaching its full diagonal rather than half of it.
  const coversWorld = Math.ceil(Math.SQRT2 * sectionsPerAxis)
  const total = sectionsPerAxis * sectionsPerAxis
  if (total <= maxResidentSections) return coversWorld
  // A disc of radius r holds about pi*r^2 sections.
  return Math.max(1, Math.floor(Math.sqrt(maxResidentSections / Math.PI)))
}

const DEFAULT_WORLD_SIZE = 4_096
const DEFAULT_SECTION_SIZE = 128
const DEFAULT_MAX_RESIDENT_SECTIONS = 1_200
const RESIDENCY_RADIUS_SECTIONS = /*@__PURE__*/ recommendedResidencyRadiusSections(
  DEFAULT_WORLD_SIZE,
  DEFAULT_SECTION_SIZE,
  DEFAULT_MAX_RESIDENT_SECTIONS,
)

export const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  // 4 km x 4 km. The demo world only ever authors and renders the massif
  // around the origin, and a 16 km logical extent bought nothing for it: the
  // far-field proxy mesh scaled with the square of the world size, the horizon
  // residency mask grew with it, and every metre past the haze horizon is
  // invisible anyway. Four kilometres still puts the far ridges beyond where
  // aerial perspective has dissolved them.
  worldSize: DEFAULT_WORLD_SIZE,
  sectionSize: DEFAULT_SECTION_SIZE,
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
  // Real terrain reaches the edge of the world. Floor and ceiling are the same
  // value, which retires the projected-footprint rule in
  // `requiredViewRadiusSections`: how much of the map exists is now decided by
  // the world's extent and the section budget rather than by how much of it the
  // viewport happens to cover, and what the map looks like at any distance is
  // left entirely to screen-space LOD selection -- the thing that was always
  // meant to answer it. The clamp still honours a config that sets the two
  // apart; nothing the helper produces does.
  renderRadiusSections: RESIDENCY_RADIUS_SECTIONS,
  maxRenderRadiusSections: RESIDENCY_RADIUS_SECTIONS,
  // About a thousand sections. Compiling and holding that many of the coarsest
  // level is a few megabytes and a couple of seconds of worker time spread over
  // the pool, which the measurements above put comfortably inside budget.
  maxResidentSections: DEFAULT_MAX_RESIDENT_SECTIONS,
  prefetchSections: 0,
  maxGpuBytes: 256 * 1024 * 1024,
  maxCpuCompiledBytes: 384 * 1024 * 1024,
  maxEditableMeshBytes: 192 * 1024 * 1024,
  maxUploadBytesPerFrame: 6 * 1024 * 1024,
  // A count, deliberately loose. Swaps differ in cost by two orders of
  // magnitude, so counting them is a poor way to bound the work: two was a
  // sensible ceiling when every swap was a near section, and with the whole
  // world resident it became the reason a full map took minutes to appear --
  // a thousand sections at two per frame is over eight seconds of nothing but
  // waiting for the queue. The upload-byte and measured-CPU budgets are what
  // actually bound a frame; this only stops one frame from taking an
  // unbounded number of them.
  maxSectionSwapsPerFrame: 32,
  // A section swap is the largest recurring piece of main-thread terrain work
  // and genuinely costs a couple of milliseconds. At 1.5 the scheduler could
  // only ever admit one as an oversized exception, which also stopped it from
  // running the deferred-disposal pass behind it, so geometry piled up for as
  // long as sections kept streaming. Four leaves room for a swap and the
  // maintenance that follows it inside a 16 ms frame.
  terrainCpuBudgetMs: 4,
  sectionRetentionMs: 12_000,
  seed: 13_371,
  worldProfile: 'natural',
  worldContent: { showcase: true, outcrops: true, rocks: 0, water: true },
}
