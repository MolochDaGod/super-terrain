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
  // The finest resolution creates the authoritative section mesh. Coarser
  // values define QEM triangle-count targets; borders and authored features
  // remain locked, so a level may deliberately retain more triangles than its
  // nominal target. 96 segments over 128 m is ~1.3 m source topology.
  lodResolutions: [96, 48, 24, 12, 6],
  operationHalo: 12,
  workerCount: Math.max(2, Math.min(4, availableWorkers - 2)),
  targetFps: 30,
  baseLodErrorPixels: 2.2,
  // Screen-error LOD alone demotes nearby terrain while the camera is elevated.
  // Keep a 3x3 authoring patch under the camera genuinely at LOD0.
  lod0FocusRadiusSections: 1.75,
  // The far-field proxy already carries the horizon. Keep only the nearest
  // kilometre of editable sections resident at launch; the projected-view
  // calculation still expands this radius automatically when the camera pulls
  // back. A radius of ten forced ~120 extra worker compiles before the initial
  // editor view could settle without improving anything visible in that view.
  renderRadiusSections: 8,
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
