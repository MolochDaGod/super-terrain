import type { Raycaster, Vector3 } from 'three'
import type {
  BrushDomain,
  BrushMode,
  BrushSample,
} from '../modifiers/types'
import type { TerrainOverlay } from '../editor/EditorStore'
import type { TerrainRenderMode } from './renderModes'
import type { CompiledSection, SectionId } from '../core/types'
import type { TerrainSection } from '../partition/MeshPartition'

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
}

export interface TerrainRenderBackend {
  upload(section: TerrainSection, compiled: CompiledSection): number
  has(sectionId: SectionId): boolean
  setLod(sectionId: SectionId, lod: number): void
  setVisible(sectionId: SectionId, visible: boolean): void
  setSectionState(section: TerrainSection): void
  setOverlay(overlay: TerrainOverlay): void
  setRenderMode(mode: TerrainRenderMode): void
  previewBrush(preview: PreviewBrush): void
  raycast(raycaster: Raycaster): TerrainRaycastHit | undefined
  flushDeferredDisposals(maxCount: number): void
  evict(sectionId: SectionId): void
  stats(): TerrainRenderStats
  dispose(): void
}
