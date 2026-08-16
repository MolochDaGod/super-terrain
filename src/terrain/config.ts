export interface TerrainConfig {
  worldSize: number
  sectionSize: number
  lodResolutions: readonly number[]
  operationHalo: number
  workerCount: number
  targetFps: number
  baseLodErrorPixels: number
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
}

const availableWorkers =
  typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency ?? 4

export const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  worldSize: 16_384,
  sectionSize: 128,
  // Power-of-two nesting keeps every coarser boundary sample present in the
  // next finer LOD, avoiding the non-matching edge polylines that exposed skirts.
  lodResolutions: [32, 16, 8, 4, 2],
  operationHalo: 12,
  workerCount: Math.max(2, Math.min(4, availableWorkers - 2)),
  targetFps: 60,
  baseLodErrorPixels: 2.2,
  renderRadiusSections: 10,
  maxRenderRadiusSections: 22,
  prefetchSections: 2,
  maxGpuBytes: 256 * 1024 * 1024,
  maxCpuCompiledBytes: 384 * 1024 * 1024,
  maxEditableMeshBytes: 192 * 1024 * 1024,
  maxUploadsPerFrame: 2,
  maxUploadBytesPerFrame: 6 * 1024 * 1024,
  maxSectionSwapsPerFrame: 2,
  terrainCpuBudgetMs: 1.5,
  sectionRetentionMs: 12_000,
  seed: 13_371,
}
