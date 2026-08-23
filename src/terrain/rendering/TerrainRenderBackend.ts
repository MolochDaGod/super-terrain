import type { Camera, Raycaster, Renderer, Scene, Vector3 } from 'three/webgpu'
import type {
  BrushDomain,
  BrushMode,
  BrushSample,
} from '../modifiers/types'
import type { TerrainOverlay } from '../editor/EditorStore'
import type { TerrainRenderMode } from './renderModes'
import type { CompiledSection, SectionId } from '../core/types'
import type { TerrainSection } from '../partition/MeshPartition'
import type {
  PaintMode,
} from '../modifiers/types'
import type {
  TerrainMaterialSettings,
  TerrainPaintChannelId,
} from './materialSettings'

export interface TerrainRenderStats {
  gpuBytes: number
  residentSections: number
  visibleSections: number
  triangles: number
  trianglesByLod: number[]
}

export interface TerrainRaycastHit {
  point: Vector3
  normal: Vector3
  sectionId: SectionId
}

export interface PreviewBrush {
  mode: BrushMode
  domain: BrushDomain
  samples: readonly BrushSample[]
  radius: number
  strength: number
  falloff: number
  targetY?: number
  terraceStep?: number
  noiseScale?: number
  noiseSeed?: number
  accumulate?: boolean
}

export interface PreviewWeightPaint {
  samples: readonly BrushSample[]
  channel: TerrainPaintChannelId
  mode: PaintMode
  radius: number
  strength: number
  falloff: number
}

export interface TerrainRenderBackend {
  upload(section: TerrainSection, compiled: CompiledSection): number
  has(sectionId: SectionId): boolean
  setLod(sectionId: SectionId, lod: number): void
  setVisible(sectionId: SectionId, visible: boolean): void
  setSectionState(section: TerrainSection): void
  setOverlay(overlay: TerrainOverlay): void
  setRenderMode(mode: TerrainRenderMode): void
  setMaterialSettings(settings: TerrainMaterialSettings): void
  /** Builds current-camera depth from last-visible bricks and applies Hi-Z. */
  updateOcclusion(renderer: Renderer, camera: Camera, scene: Scene): void
  /**
   * Opens and closes a sculpt gesture.
   *
   * Dabs arrive incrementally while the compiler evaluates the finished stroke
   * in one pass from the unsculpted surface. The backend keeps the positions
   * each section held at the press so both sides bound displacement against
   * the same reference and stay in agreement.
   */
  beginBrushPreview(): void
  endBrushPreview(): void
  previewBrush(preview: PreviewBrush): void
  previewWeightPaint(preview: PreviewWeightPaint): void
  raycast(raycaster: Raycaster): TerrainRaycastHit | undefined
  flushDeferredDisposals(maxCount: number): void
  /**
   * Consolidates settled distant sections into merged draws.
   *
   * Returns the number of merges performed, so a caller can tell a frame that
   * did work from one that had nothing to do.
   */
  flushSectionBatches(now: number, maxBatches: number): number
  evict(sectionId: SectionId): void
  stats(): TerrainRenderStats
  dispose(): void
}
