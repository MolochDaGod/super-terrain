export interface Vec3Like {
  x: number
  y: number
  z: number
}

export interface AABB {
  min: Vec3Like
  max: Vec3Like
}

export interface SectionKey {
  x: number
  z: number
}

export type SectionId = `${number}:${number}`

export type BuildState = 'clean' | 'queued' | 'building' | 'ready' | 'failed'

export type ResidencyState =
  | 'UNLOADED'
  | 'SOURCE_RESIDENT'
  | 'COMPILED_CPU'
  | 'GPU_RESIDENT'
  | 'VISIBLE'

export interface CompiledLOD {
  level: number
  /** Finest source level this artifact was simplified from. */
  sourceLevel?: number
  geometricError: number
  positions: Float32Array
  /** Two u32 words per vertex; compiler-stable and renderer-neutral. */
  stableVertexIds?: Uint32Array
  /** Authoritative source vertex retained for every compacted vertex. */
  sourceVertexIndices?: Uint32Array
  normals: Float32Array
  colors: Float32Array
  /** Five normalized u16 vec4 streams containing packed material fields and layer weights. */
  surfaceFields?: readonly [
    Uint16Array,
    Uint16Array,
    Uint16Array,
    Uint16Array,
    Uint16Array,
  ]
  /** Four user-painted material/biome weight channels, normalized u16 RGBA. */
  paintWeights?: Uint16Array
  indices: Uint32Array
  triangleCount: number
  gpuBytes: number
}

export interface CompiledTerrainMetadata {
  compileMs: number
  vertexCount: number
  triangleCount: number
  density: number
  hasArbitraryTopology: boolean
  validationWarnings: number
}

export interface CompiledSection {
  key: SectionKey
  sourceRevision: number
  bounds: AABB
  lods: CompiledLOD[]
  metadata: CompiledTerrainMetadata
  cpuBytes: number
  /** Resident render buffers only; excludes editor/source identity metadata. */
  gpuBytes?: number
}

export interface FrameBudget {
  cpuTerrainMs: number
  gpuUploadBytes: number
  sectionSwaps: number
}

export interface FrameBudgetSnapshot extends FrameBudget {
  remainingCpuMs: number
  remainingGpuUploadBytes: number
  remainingSectionSwaps: number
  violations: number
  qualityScale: number
  averageFrameMs: number
}

export interface TerrainMetrics {
  fps: number
  frameMs: number
  averageFrameMs: number
  terrainMainThreadMs: number
  terrainSchedulingMs: number
  visibleSections: number
  gpuResidentSections: number
  sourceResidentSections: number
  compiledCpuSections: number
  trianglesRendered: number
  trianglesByLod: number[]
  workerActiveJobs: number
  workerQueuedJobs: number
  staleJobs: number
  cancelledJobs: number
  sectionsRebuilding: number
  sectionsSwapped: number
  gpuUploadBytes: number
  gpuBytes: number
  cpuBytes: number
  streamLoadsPerSecond: number
  streamEvictionsPerSecond: number
  qualityScale: number
  frameBudgetViolations: number
  activeBenchmark: string | null
  compileP50Ms: number
  compileP95Ms: number
  /** Sections whose latest compile threw, and one representative message. */
  failedSections: number
  lastCompileError: string | null
}

export const EMPTY_METRICS: TerrainMetrics = {
  fps: 60,
  frameMs: 16.67,
  averageFrameMs: 16.67,
  terrainMainThreadMs: 0,
  terrainSchedulingMs: 0,
  visibleSections: 0,
  gpuResidentSections: 0,
  sourceResidentSections: 0,
  compiledCpuSections: 0,
  trianglesRendered: 0,
  trianglesByLod: [0, 0, 0, 0, 0],
  workerActiveJobs: 0,
  workerQueuedJobs: 0,
  staleJobs: 0,
  cancelledJobs: 0,
  sectionsRebuilding: 0,
  sectionsSwapped: 0,
  gpuUploadBytes: 0,
  gpuBytes: 0,
  cpuBytes: 0,
  streamLoadsPerSecond: 0,
  streamEvictionsPerSecond: 0,
  qualityScale: 1,
  frameBudgetViolations: 0,
  activeBenchmark: null,
  compileP50Ms: 0,
  compileP95Ms: 0,
  failedSections: 0,
  lastCompileError: null,
}
