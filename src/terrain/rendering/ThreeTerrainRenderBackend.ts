import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Mesh,
  MeshStandardNodeMaterial,
  Matrix3,
  Raycaster,
  type Renderer,
  type Scene,
  Sphere,
  Vector3,
} from 'three/webgpu'
import { smoothstep } from '../core/bounds'
import {
  applyBrushDab,
  maximumDabDisplacement,
  type BrushKernelParams,
  type MutablePoint,
} from '../modifiers/brushKernel'
import type { CompiledLOD, CompiledSection, SectionId } from '../core/types'
import type { TerrainOverlay } from '../editor/EditorStore'
import type { TerrainSection } from '../partition/MeshPartition'
import type {
  PreviewBrush,
  PreviewWeightPaint,
  TerrainRaycastHit,
  TerrainRenderBackend,
  TerrainRenderStats,
} from './TerrainRenderBackend'
import {
  createTerrainMaterialForMode,
  type TerrainMaterialHandle,
  type TerrainMaterialReadiness,
} from './createTerrainMaterialForMode'
import type { FullMaterialDebug } from './full/createFullTerrainMaterial'
import type { TerrainRenderMode } from './renderModes'
import { createSectionGeometry } from './createSectionGeometry'
import {
  createTerrainBrickGeometries,
  expandTerrainBrickBounds,
  type TerrainBrickGeometry,
} from './TerrainBricks'
import { invalidateTerrainShadows } from './environment/terrainShadowInvalidation'
import {
  disposeTerrainBoundsTree,
  ensureTerrainBoundsTree,
  refitTerrainBoundsTree,
} from './terrainRaycastAcceleration'
import {
  cloneTerrainMaterialSettings,
  DEFAULT_TERRAIN_MATERIAL_SETTINGS,
  paintChannelIndex,
  type TerrainMaterialSettings,
} from './materialSettings'
import { retireGpuResource } from './gpuResourceRetirement'

interface RuntimeBrick extends TerrainBrickGeometry {
  id: string
  mesh: Mesh
}

interface RuntimeLod {
  source: BufferGeometry
  bricks: RuntimeBrick[]
}

interface RuntimeSection {
  section: TerrainSection
  /** Compiled source for every level, kept so a level can be built on demand. */
  compiled: Map<number, CompiledLOD>
  /** Only the levels that have actually been displayed. */
  lods: Map<number, RuntimeLod>
  boundary: LineSegments
  gpuBytes: number
  lod: number
  visible: boolean
}

interface DeferredGeometry {
  geometry: BufferGeometry
  framesRemaining: number
}

const LOD_COLORS = [0x59dca9, 0x89c95a, 0xe5c65f, 0xe58d52, 0xd95f69]

/**
 * Merged draws for the settled far field.
 *
 * Triangles were never the problem at world scale: a thousand resident sections
 * is a thousand draw calls, a thousand matrix updates and a thousand bind-group
 * switches per frame, and zoomed out none of it is culled because all of it is
 * on screen. Sections that have stopped changing are copied into one geometry
 * per grid cell and level, which leaves the frame drawing tens of objects
 * instead of hundreds while rendering exactly the same triangles with exactly
 * the same material.
 *
 * The rules are all about never merging anything the user is working on:
 * only coarse levels join (the fine ones are the near ring and the edit
 * target), a section that changes in any way leaves its batch immediately and
 * goes back to its own mesh, and a batch waits out a settle delay before it is
 * rebuilt so a moving camera does not pay for merges it is about to invalidate.
 */
const BATCH_GRID_SECTIONS = 4
const BATCH_MIN_LOD = 2
const BATCH_MIN_MEMBERS = 4
const BATCH_SETTLE_MS = 220

interface SectionBatch {
  key: string
  level: number
  members: Set<SectionId>
  mesh?: Mesh
  /** 0 once `mesh` describes the current members; a timestamp while it does not. */
  dirtySince: number
}

export class ThreeTerrainRenderBackend implements TerrainRenderBackend {
  private readonly root: Group
  private readonly surfaceRoot: Group
  private readonly sectionSize: number
  private readonly brickSize: number
  private runtime = new Map<SectionId, RuntimeSection>()
  private deferredDisposals: DeferredGeometry[] = []
  private overlay: TerrainOverlay = 'none'
  private renderMode: TerrainRenderMode = 'preview'
  private materialSettings = cloneTerrainMaterialSettings(
    DEFAULT_TERRAIN_MATERIAL_SETTINGS,
  )
  private terrainMaterial: TerrainMaterialHandle
  private readonly lodMaterials: MeshStandardNodeMaterial[]
  private readonly densityMaterial: MeshStandardNodeMaterial
  private readonly boundaryMaterials = {
    clean: new LineBasicMaterial({ color: 0x7c9688, transparent: true, opacity: 0.32 }),
    dirty: new LineBasicMaterial({ color: 0xffae57, transparent: true, opacity: 0.9 }),
    building: new LineBasicMaterial({ color: 0x64d8ff, transparent: true, opacity: 0.95 }),
    failed: new LineBasicMaterial({ color: 0xff5d68, transparent: true, opacity: 1 }),
  }
  private batches = new Map<string, SectionBatch>()
  private batchOfSection = new Map<SectionId, string>()
  private readonly scratchSphere = new Sphere()
  private readonly scratchPoint = new Vector3()
  private readonly scratchNormal = new Vector3()
  private readonly scratchNormalMatrix = new Matrix3()
  private readonly pendingPreviewRefresh = new Set<BufferGeometry>()
  private readonly pendingBrickRefit = new Set<BufferGeometry>()
  private readonly strokeAnchors = new Map<BufferGeometry, Float32Array>()
  private previewRefreshHandle?: number

  private readonly debugView: FullMaterialDebug

  constructor(
    root: Group,
    sectionSize: number,
    debugView: FullMaterialDebug = 'none',
  ) {
    this.debugView = debugView
    this.root = root
    this.surfaceRoot = new Group()
    this.surfaceRoot.name = 'terrain-static-surfaces'
    this.root.add(this.surfaceRoot)
    this.sectionSize = sectionSize
    // One draw per active section. The old 64 m cubic split turned a single
    // mountainous section into 10–30 meshes along Y, taking the hero frame to
    // 3,230 terrain draw calls and then rendering all of them again for a CPU
    // readback Hi-Z pass. Section frustum culling plus the coarse horizon proxy
    // is the better trade at this world scale.
    this.brickSize = Number.POSITIVE_INFINITY
    this.terrainMaterial = createTerrainMaterialForMode(
      this.renderMode,
      this.debugView,
      this.materialSettings,
    )
    this.lodMaterials = LOD_COLORS.map(
      (color) =>
        new MeshStandardNodeMaterial({
          color,
          roughness: 0.92,
          metalness: 0,
          side: DoubleSide,
        }),
    )
    this.densityMaterial = new MeshStandardNodeMaterial({
      color: 0x70d2b0,
      roughness: 0.9,
      wireframe: true,
      side: DoubleSide,
    })
  }

  upload(section: TerrainSection, compiled: CompiledSection): number {
    const gpuBytes = compiled.gpuBytes ?? compiled.lods.reduce(
      (bytes, lod) => bytes + lod.gpuBytes,
      0,
    )
    // Only the level about to be displayed is turned into geometry here. A
    // section carries five, of which the renderer draws exactly one, and
    // building the other four cost skirting, attribute construction and bounds
    // for meshes that were usually evicted before they were ever selected --
    // all of it on the main thread, inside the frame that installs the section.
    // `materializeLod` builds the rest on the swap that first asks for them.
    const compiledLods = new Map(compiled.lods.map((lod) => [lod.level, lod]))
    let runtime = this.runtime.get(section.id)
    if (runtime) {
      // The merged copy describes geometry this upload is about to replace.
      this.breakBatchOf(section.id)
      this.detachActiveLod(runtime)
      this.deferRuntimeLods(runtime.lods)
      runtime.lods = new Map()
      runtime.compiled = compiledLods
      runtime.gpuBytes = gpuBytes
      runtime.section = section
      runtime.lod = closestAvailableLod(compiledLods, runtime.lod)
      this.attachActiveLod(runtime)
      this.updateBoundary(runtime, compiled)
    } else {
      const initialLod = closestAvailableLod(
        compiledLods,
        section.requestedLod,
      )
      const boundary = createBoundary(
        section,
        compiled,
        this.boundaryMaterials.clean,
        this.sectionSize,
      )
      this.root.add(boundary)
      runtime = {
        section,
        compiled: compiledLods,
        lods: new Map(),
        boundary,
        gpuBytes,
        lod: initialLod,
        visible: true,
      }
      this.runtime.set(section.id, runtime)
      this.attachActiveLod(runtime)
    }
    this.applyMaterial(runtime)
    this.setSectionState(section)
    this.refreshBatchMembership(runtime)
    invalidateTerrainShadows()
    return gpuBytes
  }

  has(sectionId: SectionId): boolean {
    return this.runtime.has(sectionId)
  }

  setLod(sectionId: SectionId, lod: number): void {
    const runtime = this.runtime.get(sectionId)
    if (!runtime) return
    const next = closestAvailableLod(runtime.compiled, lod)
    if (next === runtime.lod) return
    this.breakBatchOf(sectionId)
    this.detachActiveLod(runtime)
    runtime.lod = next
    runtime.section.activeLod = next
    this.attachActiveLod(runtime)
    this.applyMaterial(runtime)
    this.refreshBatchMembership(runtime)
    invalidateTerrainShadows()
  }

  setVisible(sectionId: SectionId, visible: boolean): void {
    const runtime = this.runtime.get(sectionId)
    if (!runtime || runtime.visible === visible) return
    this.breakBatchOf(sectionId)
    runtime.visible = visible
    for (const brick of this.activeBricks(runtime)) {
      brick.mesh.visible = visible
    }
    runtime.boundary.visible = visible && this.overlay !== 'none'
    this.refreshBatchMembership(runtime)
    invalidateTerrainShadows()
  }

  setSectionState(section: TerrainSection): void {
    const runtime = this.runtime.get(section.id)
    if (!runtime) return
    if (section.buildState === 'failed') {
      runtime.boundary.material = this.boundaryMaterials.failed
    } else if (section.buildState === 'building') {
      runtime.boundary.material = this.boundaryMaterials.building
    } else if (section.dirtyRegion) {
      runtime.boundary.material = this.boundaryMaterials.dirty
    } else {
      runtime.boundary.material = this.boundaryMaterials.clean
    }
    runtime.boundary.visible = runtime.visible && this.overlay !== 'none'
  }

  /**
   * Swaps the surface material for every resident section. Geometry is
   * untouched, so toggling quality never re-streams or re-compiles anything.
   */
  setRenderMode(mode: TerrainRenderMode): TerrainMaterialReadiness {
    if (this.renderMode === mode) return this.materialReadiness()
    this.renderMode = mode
    const previous = this.terrainMaterial
    this.terrainMaterial = createTerrainMaterialForMode(
      mode,
      this.debugView,
      this.materialSettings,
    )
    for (const runtime of this.runtime.values()) {
      const castsShadow = mode === 'full'
      for (const lod of runtime.lods.values()) {
        for (const brick of lod.bricks) {
          brick.mesh.castShadow = castsShadow
          brick.mesh.receiveShadow = castsShadow
        }
      }
      this.applyMaterial(runtime)
    }
    this.refreshBatchMaterials()
    retireGpuResource(() => previous.dispose())
    invalidateTerrainShadows()
    return this.materialReadiness()
  }

  private materialReadiness(): TerrainMaterialReadiness {
    return {
      previewReady: this.terrainMaterial.previewReady,
      ready: this.terrainMaterial.ready,
    }
  }

  setMaterialSettings(settings: TerrainMaterialSettings): void {
    this.materialSettings = cloneTerrainMaterialSettings(settings)
    const previous = this.terrainMaterial
    this.terrainMaterial = createTerrainMaterialForMode(
      this.renderMode,
      this.debugView,
      this.materialSettings,
    )
    for (const runtime of this.runtime.values()) this.applyMaterial(runtime)
    this.refreshBatchMaterials()
    retireGpuResource(() => previous.dispose())
    invalidateTerrainShadows()
  }

  updateOcclusion(renderer: Renderer, camera: Camera, scene: Scene): void {
    // Deliberately section/frustum culled. A per-frame depth render and GPU→CPU
    // readback costs more than it saves once each section is one draw call.
    void renderer
    void camera
    void scene
  }

  setOverlay(overlay: TerrainOverlay): void {
    if (this.overlay === overlay) return
    this.overlay = overlay
    for (const runtime of this.runtime.values()) {
      this.applyMaterial(runtime)
      runtime.boundary.visible = runtime.visible && overlay !== 'none'
    }
    this.refreshBatchMaterials()
    invalidateTerrainShadows()
  }

  beginBrushPreview(): void {
    this.strokeAnchors.clear()
  }

  endBrushPreview(): void {
    this.strokeAnchors.clear()
  }

  previewBrush(preview: PreviewBrush): void {
    if (preview.samples.length === 0) return
    const samples = preview.samples.map(preparePreviewSample)
    const minimumBrushX =
      Math.min(...samples.map((sample) => sample.x)) - preview.radius
    const maximumBrushX =
      Math.max(...samples.map((sample) => sample.x)) + preview.radius
    const minimumBrushZ =
      Math.min(...samples.map((sample) => sample.z)) - preview.radius
    const maximumBrushZ =
      Math.max(...samples.map((sample) => sample.z)) + preview.radius

    for (const runtime of this.runtime.values()) {
      if (!runtime.visible) continue
      const minX = runtime.section.key.x * this.sectionSize
      const minZ = runtime.section.key.z * this.sectionSize
      if (
        maximumBrushX < minX ||
        minimumBrushX > minX + this.sectionSize ||
        maximumBrushZ < minZ ||
        minimumBrushZ > minZ + this.sectionSize
      ) {
        continue
      }
      const sectionSamples = samples.filter(
        (sample) =>
          sample.x + preview.radius >= minX &&
          sample.x - preview.radius <= minX + this.sectionSize &&
          sample.z + preview.radius >= minZ &&
          sample.z - preview.radius <= minZ + this.sectionSize,
      )
      // Only the displayed LOD needs a speculative mutation. The worker swap
      // replaces every LOD authoritatively, while keeping pointer events cheap.
      const activeLod = runtime.lods.get(runtime.lod)!
      const maximumDisplacement = applyPreviewToGeometry(
        activeLod.source,
        this.strokeAnchorFor(activeLod.source),
        minX,
        minZ,
        preview,
        sectionSamples,
      )
      if (maximumDisplacement > 0) {
        // A merged copy holds the positions from before this dab. Sections
        // under a brush are forced to the finest level and so are normally
        // unmerged already; this covers the frame where they are not.
        this.breakBatchOf(runtime.section.id)
        expandPreviewBounds(activeLod.source, maximumDisplacement)
        expandTerrainBrickBounds(activeLod.bricks, maximumDisplacement)
        // Bricks share the positions that just moved, so any tree already built
        // over them now describes the shape before the stroke. Refitting is the
        // most expensive thing a dab can trigger, so it is collapsed to once per
        // frame -- or to the next ray, whichever comes first.
        for (const brick of activeLod.bricks) {
          this.pendingBrickRefit.add(brick.geometry)
        }
        this.queuePreviewRefresh(activeLod.source)
      }
    }
  }

  previewWeightPaint(preview: PreviewWeightPaint): void {
    if (preview.samples.length === 0) return
    const samples = preview.samples.map(preparePreviewSample)
    const channel = paintChannelIndex(preview.channel)
    const minimumBrushX =
      Math.min(...samples.map((sample) => sample.x)) - preview.radius
    const maximumBrushX =
      Math.max(...samples.map((sample) => sample.x)) + preview.radius
    const minimumBrushZ =
      Math.min(...samples.map((sample) => sample.z)) - preview.radius
    const maximumBrushZ =
      Math.max(...samples.map((sample) => sample.z)) + preview.radius
    const minimumSectionX = Math.floor(minimumBrushX / this.sectionSize)
    const maximumSectionX = Math.floor(maximumBrushX / this.sectionSize)
    const minimumSectionZ = Math.floor(minimumBrushZ / this.sectionSize)
    const maximumSectionZ = Math.floor(maximumBrushZ / this.sectionSize)

    // Resolve only the section IDs overlapped by this dab. A large streamed
    // world can have hundreds of resident meshes, but a normal brush touches
    // one to four of them.
    for (let z = minimumSectionZ; z <= maximumSectionZ; z += 1) {
      for (let x = minimumSectionX; x <= maximumSectionX; x += 1) {
        const runtime = this.runtime.get(`${x}:${z}` as SectionId)
        if (!runtime) continue
        const originX = x * this.sectionSize
        const originZ = z * this.sectionSize
        const sectionSamples = samples.filter(
          (sample) =>
            sample.x + preview.radius >= originX &&
            sample.x - preview.radius <= originX + this.sectionSize &&
            sample.z + preview.radius >= originZ &&
            sample.z - preview.radius <= originZ + this.sectionSize,
        )
        const changed = applyWeightPreviewToGeometry(
          runtime.lods.get(runtime.lod)!.source,
          originX,
          originZ,
          preview,
          sectionSamples,
          channel,
        )
        if (changed > 0) this.breakBatchOf(runtime.section.id)
      }
    }
  }

  raycast(raycaster: Raycaster): TerrainRaycastHit | undefined {
    this.flushBrickRefits()
    // Only what the ray actually crosses gets a tree. Building one costs a few
    // milliseconds, and with the whole world resident the old sweep paid that
    // for a thousand sections on the first cast after a zoom-out -- for a ray
    // that can only ever touch a handful of them.
    for (const runtime of this.runtime.values()) {
      if (!runtime.visible) continue
      if (this.batchOfSection.has(runtime.section.id)) continue
      for (const brick of this.activeBricks(runtime)) {
        if (!brick.mesh.visible) continue
        if (!this.rayCrosses(raycaster, brick.mesh)) continue
        ensureTerrainBoundsTree(brick.geometry)
      }
    }
    for (const batch of this.batches.values()) {
      if (!batch.mesh) continue
      if (!this.rayCrosses(raycaster, batch.mesh)) continue
      ensureTerrainBoundsTree(batch.mesh.geometry)
    }
    // The nearest hit on each mesh is the only one that can win, and the list
    // comes back sorted, so the deeper hits behind it are pure work.
    const previousFirstHitOnly = raycaster.firstHitOnly
    raycaster.firstHitOnly = true
    let hits
    try {
      hits = raycaster.intersectObject(this.root, true)
    } finally {
      raycaster.firstHitOnly = previousFirstHitOnly
    }
    for (const hit of hits) {
      const id =
        (hit.object.userData.terrainSectionId as SectionId | undefined) ??
        (hit.object.userData.terrainBatchKey
          ? this.sectionIdAt(hit.point)
          : undefined)
      if (!id) continue
      this.scratchPoint.copy(hit.point)
      if (hit.face) {
        this.scratchNormalMatrix.getNormalMatrix(hit.object.matrixWorld)
        this.scratchNormal
          .copy(hit.face.normal)
          .applyNormalMatrix(this.scratchNormalMatrix)
          .normalize()
      } else {
        this.scratchNormal.set(0, 1, 0)
      }
      return {
        point: this.scratchPoint.clone(),
        normal: this.scratchNormal.clone(),
        sectionId: id,
      }
    }
    return undefined
  }

  /** Conservative broad phase: does the ray reach this mesh's bounds at all? */
  private rayCrosses(raycaster: Raycaster, mesh: Mesh): boolean {
    const sphere = mesh.geometry.boundingSphere
    if (!sphere) return true
    this.scratchSphere.copy(sphere).applyMatrix4(mesh.matrixWorld)
    return raycaster.ray.intersectsSphere(this.scratchSphere)
  }

  /** The section a world point belongs to, for hits on a merged draw. */
  private sectionIdAt(point: Vector3): SectionId {
    const x = Math.floor(point.x / this.sectionSize)
    const z = Math.floor(point.z / this.sectionSize)
    return `${x}:${z}` as SectionId
  }

  flushDeferredDisposals(maxCount: number): void {
    let disposed = 0
    const retained: DeferredGeometry[] = []
    for (const pending of this.deferredDisposals) {
      pending.framesRemaining -= 1
      if (pending.framesRemaining <= 0 && disposed < maxCount) {
        retireGpuResource(() => pending.geometry.dispose())
        disposed += 1
      } else {
        retained.push(pending)
      }
    }
    this.deferredDisposals = retained
  }

  evict(sectionId: SectionId): void {
    const runtime = this.runtime.get(sectionId)
    if (!runtime) return
    this.removeFromBatch(sectionId)
    this.detachActiveLod(runtime)
    this.root.remove(runtime.boundary)
    this.deferRuntimeLods(runtime.lods)
    this.deferGeometries([runtime.boundary.geometry])
    this.runtime.delete(sectionId)
    invalidateTerrainShadows()
  }

  stats(): TerrainRenderStats {
    const trianglesByLod = [0, 0, 0, 0, 0]
    let gpuBytes = 0
    let visibleSections = 0
    let triangles = 0
    for (const runtime of this.runtime.values()) {
      gpuBytes += runtime.gpuBytes
      if (!runtime.visible) continue
      const visibleBricks = this.activeBricks(runtime).filter(
        (brick) => brick.mesh.visible,
      )
      if (visibleBricks.length === 0) continue
      visibleSections += 1
      const sectionTriangles = visibleBricks.reduce(
        (sum, brick) => sum + brick.triangleCount,
        0,
      )
      triangles += sectionTriangles
      trianglesByLod[runtime.lod] =
        (trianglesByLod[runtime.lod] ?? 0) + sectionTriangles
    }
    return {
      gpuBytes,
      residentSections: this.runtime.size,
      visibleSections,
      triangles,
      trianglesByLod,
    }
  }

  dispose(): void {
    if (
      this.previewRefreshHandle !== undefined &&
      typeof cancelAnimationFrame === 'function'
    ) {
      cancelAnimationFrame(this.previewRefreshHandle)
    }
    this.previewRefreshHandle = undefined
    this.pendingPreviewRefresh.clear()
    this.pendingBrickRefit.clear()
    this.strokeAnchors.clear()
    for (const id of [...this.runtime.keys()]) this.evict(id)
    for (const batch of this.batches.values()) {
      if (batch.mesh) {
        this.surfaceRoot.remove(batch.mesh)
        const geometry = batch.mesh.geometry
        retireGpuResource(() => geometry.dispose())
      }
    }
    this.batches.clear()
    this.batchOfSection.clear()
    for (const pending of this.deferredDisposals) {
      retireGpuResource(() => pending.geometry.dispose())
    }
    this.deferredDisposals.length = 0
    this.root.remove(this.surfaceRoot)
    this.terrainMaterial.dispose()
    this.densityMaterial.dispose()
    for (const material of this.lodMaterials) material.dispose()
    for (const material of Object.values(this.boundaryMaterials)) material.dispose()
  }

  /**
   * Rebuilds up to `maxBatches` merged draws whose members have settled.
   *
   * Called from the terrain frame budget, so a merge competes with uploads and
   * swaps for main-thread time rather than landing on top of them.
   */
  flushSectionBatches(now: number, maxBatches: number): number {
    let built = 0
    for (const batch of [...this.batches.values()]) {
      if (batch.members.size === 0) {
        this.batches.delete(batch.key)
        continue
      }
      if (built >= maxBatches) continue
      if (batch.mesh || batch.dirtySince === 0) continue
      if (batch.members.size < BATCH_MIN_MEMBERS) continue
      if (now - batch.dirtySince < BATCH_SETTLE_MS) continue
      if (this.buildBatch(batch)) built += 1
    }
    return built
  }

  /** Grid cell and level a section may merge into, or undefined if it may not. */
  private batchKeyFor(runtime: RuntimeSection): string | undefined {
    if (!runtime.visible) return undefined
    if (runtime.lod < BATCH_MIN_LOD) return undefined
    if (!runtime.lods.has(runtime.lod)) return undefined
    const cellX = Math.floor(runtime.section.key.x / BATCH_GRID_SECTIONS)
    const cellZ = Math.floor(runtime.section.key.z / BATCH_GRID_SECTIONS)
    return `${cellX}:${cellZ}:${runtime.lod}`
  }

  /**
   * Re-files a section that has just changed.
   *
   * Any change breaks the merged mesh it was part of first, which restores
   * every member to its own mesh. That keeps one invariant the rest of the
   * class depends on: while a section is being touched, it is drawn by its own
   * mesh, so attach, detach, preview and material paths need no special case.
   */
  private refreshBatchMembership(runtime: RuntimeSection): void {
    const id = runtime.section.id
    const previousKey = this.batchOfSection.get(id)
    const nextKey = this.batchKeyFor(runtime)
    if (previousKey === nextKey) return
    if (previousKey) {
      const previous = this.batches.get(previousKey)
      if (previous) {
        this.breakBatch(previous)
        previous.members.delete(id)
        if (previous.members.size === 0) this.batches.delete(previousKey)
      }
      this.batchOfSection.delete(id)
    }
    if (!nextKey) return
    let batch = this.batches.get(nextKey)
    if (!batch) {
      batch = {
        key: nextKey,
        level: runtime.lod,
        members: new Set(),
        dirtySince: 0,
      }
      this.batches.set(nextKey, batch)
    }
    this.breakBatch(batch)
    batch.members.add(id)
    this.batchOfSection.set(id, nextKey)
    batch.dirtySince = performance.now()
  }

  /** Drops a merged mesh and puts its members back on their own. */
  private breakBatch(batch: SectionBatch): void {
    if (batch.mesh) {
      this.surfaceRoot.remove(batch.mesh)
      this.deferGeometries([batch.mesh.geometry])
      batch.mesh = undefined
      for (const id of batch.members) {
        const runtime = this.runtime.get(id)
        if (runtime) this.attachActiveLod(runtime)
      }
    }
    batch.dirtySince = performance.now()
  }

  /** Drops a section out of its batch entirely, for eviction and disposal. */
  private removeFromBatch(sectionId: SectionId): void {
    const key = this.batchOfSection.get(sectionId)
    if (!key) return
    this.batchOfSection.delete(sectionId)
    const batch = this.batches.get(key)
    if (!batch) return
    this.breakBatch(batch)
    batch.members.delete(sectionId)
    if (batch.members.size === 0) this.batches.delete(key)
  }

  /** Breaks the batch holding this section, if any, without re-filing it. */
  private breakBatchOf(sectionId: SectionId): void {
    const key = this.batchOfSection.get(sectionId)
    if (!key) return
    const batch = this.batches.get(key)
    if (batch) this.breakBatch(batch)
  }

  private buildBatch(batch: SectionBatch): boolean {
    const parts: { geometry: BufferGeometry; offsetX: number; offsetZ: number }[] = []
    for (const id of batch.members) {
      const runtime = this.runtime.get(id)
      if (!runtime || !runtime.visible || runtime.lod !== batch.level) return false
      const lod = runtime.lods.get(runtime.lod)
      if (!lod) return false
      for (const brick of lod.bricks) {
        if (!brick.mesh.visible) continue
        parts.push({
          geometry: brick.geometry,
          offsetX: runtime.section.key.x * this.sectionSize,
          offsetZ: runtime.section.key.z * this.sectionSize,
        })
      }
    }
    if (parts.length < BATCH_MIN_MEMBERS) return false
    const merged = mergeTerrainGeometries(parts)
    if (!merged) return false

    const mesh = new Mesh(merged, this.materialForLevel(batch.level))
    const castsShadow = this.renderMode === 'full'
    mesh.castShadow = castsShadow
    mesh.receiveShadow = castsShadow
    mesh.frustumCulled = true
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    mesh.name = `terrain-batch-${batch.key}`
    mesh.userData.terrainBatchKey = batch.key
    batch.mesh = mesh

    for (const id of batch.members) {
      const runtime = this.runtime.get(id)
      if (runtime) this.detachActiveLod(runtime)
    }
    this.surfaceRoot.add(mesh)
    batch.dirtySince = 0
    invalidateTerrainShadows()
    return true
  }

  private materialForLevel(level: number): Material {
    if (this.overlay === 'lod') {
      return this.lodMaterials[level] ?? this.lodMaterials.at(-1)!
    }
    if (this.overlay === 'density') return this.densityMaterial
    return this.terrainMaterial.material
  }

  /** Re-points merged draws at the current material without rebuilding them. */
  private refreshBatchMaterials(): void {
    const castsShadow = this.renderMode === 'full'
    for (const batch of this.batches.values()) {
      if (!batch.mesh) continue
      batch.mesh.material = this.materialForLevel(batch.level)
      batch.mesh.castShadow = castsShadow
      batch.mesh.receiveShadow = castsShadow
    }
  }

  private applyMaterial(runtime: RuntimeSection): void {
    for (const [level, lod] of runtime.lods) {
      this.applyMaterialToLod(level, lod)
    }
  }

  private applyMaterialToLod(level: number, lod: RuntimeLod): void {
    const material = this.overlay === 'lod'
      ? this.lodMaterials[level] ?? this.lodMaterials.at(-1)!
      : this.overlay === 'density'
        ? this.densityMaterial
        : this.terrainMaterial.material
    for (const brick of lod.bricks) brick.mesh.material = material
  }

  private createRuntimeLod(
    section: TerrainSection,
    level: number,
    source: BufferGeometry,
  ): RuntimeLod {
    const bricks = createTerrainBrickGeometries(source, this.brickSize).map(
      (brick, index): RuntimeBrick => {
        const id = `${section.id}/${level}/${brick.cellKey}`
        const mesh = createTerrainMesh(
          section,
          brick.geometry,
          this.terrainMaterial.material,
          this.sectionSize,
        )
        mesh.name = index === 0
          ? `terrain-section-${section.id}`
          : `terrain-section-${section.id}-brick-${brick.cellKey}`
        mesh.userData.terrainBrickId = id
        const castsShadow = this.renderMode === 'full'
        mesh.castShadow = castsShadow
        mesh.receiveShadow = castsShadow
        return { ...brick, id, mesh }
      },
    )
    return { source, bricks }
  }

  private activeBricks(runtime: RuntimeSection): RuntimeBrick[] {
    return this.materializeLod(runtime, runtime.lod)?.bricks ?? []
  }

  /**
   * The runtime geometry for one level, built on first use.
   *
   * Returns undefined only when the compile produced no such level, which
   * `closestAvailableLod` already rules out for anything this asks for.
   */
  private materializeLod(
    runtime: RuntimeSection,
    level: number,
  ): RuntimeLod | undefined {
    const existing = runtime.lods.get(level)
    if (existing) return existing
    const compiled = runtime.compiled.get(level)
    if (!compiled) return undefined
    const lod = this.createRuntimeLod(
      runtime.section,
      level,
      createSectionGeometry(compiled, this.sectionSize),
    )
    runtime.lods.set(level, lod)
    this.applyMaterialToLod(level, lod)
    return lod
  }

  private attachActiveLod(runtime: RuntimeSection): void {
    for (const brick of this.activeBricks(runtime)) {
      this.surfaceRoot.add(brick.mesh)
      brick.mesh.visible = runtime.visible
    }
  }

  private detachActiveLod(runtime: RuntimeSection): void {
    for (const brick of this.activeBricks(runtime)) {
      this.surfaceRoot.remove(brick.mesh)
    }
  }

  private deferRuntimeLods(lods: ReadonlyMap<number, RuntimeLod>): void {
    const geometries: BufferGeometry[] = []
    for (const lod of lods.values()) {
      geometries.push(lod.source)
      for (const brick of lod.bricks) geometries.push(brick.geometry)
    }
    this.deferGeometries(geometries)
  }

  private updateBoundary(runtime: RuntimeSection, compiled: CompiledSection): void {
    const previous = runtime.boundary
    const material = previous.material as LineBasicMaterial
    runtime.boundary = createBoundary(
      runtime.section,
      compiled,
      material,
      this.sectionSize,
    )
    runtime.boundary.visible = runtime.visible && this.overlay !== 'none'
    this.root.remove(previous)
    this.root.add(runtime.boundary)
    this.deferGeometries([previous.geometry])
  }

  private deferGeometries(geometries: BufferGeometry[]): void {
    for (const geometry of geometries) {
      this.pendingPreviewRefresh.delete(geometry)
      this.pendingBrickRefit.delete(geometry)
      this.strokeAnchors.delete(geometry)
      // The tree indexes positions this geometry is about to stop owning, and
      // nothing can raycast a detached mesh, so it goes now rather than waiting
      // out the disposal delay that exists for in-flight GPU frames.
      disposeTerrainBoundsTree(geometry)
      this.deferredDisposals.push({ geometry, framesRemaining: 4 })
    }
  }

  private queuePreviewRefresh(geometry: BufferGeometry): void {
    this.pendingPreviewRefresh.add(geometry)
    // Positions have already changed; the next frame must not reuse a shadow
    // cast by their old shape while normal rebuilding waits for its RAF batch.
    invalidateTerrainShadows()
    if (this.previewRefreshHandle !== undefined) return
    if (typeof requestAnimationFrame !== 'function') {
      this.flushPreviewRefresh()
      return
    }
    this.previewRefreshHandle = requestAnimationFrame(() => {
      this.previewRefreshHandle = undefined
      this.flushPreviewRefresh()
    })
  }

  /**
   * Positions this geometry held when the gesture began.
   *
   * Taken on the first dab that reaches the section rather than at the press,
   * so a stroke that never touches a section never copies its buffer.
   */
  private strokeAnchorFor(geometry: BufferGeometry): Float32Array {
    const existing = this.strokeAnchors.get(geometry)
    if (existing) return existing
    const positions = (geometry.getAttribute('position') as BufferAttribute)
      .array as Float32Array
    const anchor = Float32Array.from(positions)
    this.strokeAnchors.set(geometry, anchor)
    return anchor
  }

  /** Brings deferred BVH refits up to date before anything reads a tree. */
  private flushBrickRefits(): void {
    if (this.pendingBrickRefit.size === 0) return
    for (const geometry of this.pendingBrickRefit) {
      refitTerrainBoundsTree(geometry)
    }
    this.pendingBrickRefit.clear()
  }

  private flushPreviewRefresh(): void {
    this.flushBrickRefits()
    if (this.pendingPreviewRefresh.size === 0) return
    for (const geometry of this.pendingPreviewRefresh) {
      geometry.computeVertexNormals()
      const normal = geometry.getAttribute('normal') as BufferAttribute | undefined
      if (normal) normal.needsUpdate = true
    }
    this.pendingPreviewRefresh.clear()
  }
}

/**
 * Concatenates section geometries into one, baking each section's world offset
 * into its positions.
 *
 * Bails out rather than guessing whenever the parts disagree about their
 * attribute set: a merged draw must be pixel-identical to the draws it
 * replaces, and a missing paint-weight or surface-field stream would not be.
 */
function mergeTerrainGeometries(
  parts: readonly { geometry: BufferGeometry; offsetX: number; offsetZ: number }[],
): BufferGeometry | undefined {
  const template = parts[0]?.geometry
  if (!template) return undefined
  const names = Object.keys(template.attributes)
  let vertexCount = 0
  let indexCount = 0
  for (const part of parts) {
    const index = part.geometry.getIndex()
    const position = part.geometry.getAttribute('position') as
      | BufferAttribute
      | undefined
    if (!index || !position) return undefined
    if (Object.keys(part.geometry.attributes).length !== names.length) return undefined
    for (const name of names) {
      const attribute = part.geometry.getAttribute(name) as BufferAttribute | undefined
      const reference = template.getAttribute(name) as BufferAttribute
      if (
        !attribute ||
        attribute.itemSize !== reference.itemSize ||
        attribute.normalized !== reference.normalized ||
        attribute.array.constructor !== reference.array.constructor
      ) {
        return undefined
      }
    }
    vertexCount += position.count
    indexCount += index.count
  }

  const merged = new BufferGeometry()
  for (const name of names) {
    const reference = template.getAttribute(name) as BufferAttribute
    const Constructor = reference.array.constructor as new (
      length: number,
    ) => typeof reference.array
    const values = new Constructor(vertexCount * reference.itemSize)
    let cursor = 0
    for (const part of parts) {
      const attribute = part.geometry.getAttribute(name) as BufferAttribute
      values.set(attribute.array, cursor)
      if (name === 'position') {
        for (let offset = cursor; offset < cursor + attribute.array.length; offset += 3) {
          values[offset] += part.offsetX
          values[offset + 2] += part.offsetZ
        }
      }
      cursor += attribute.array.length
    }
    merged.setAttribute(
      name,
      new BufferAttribute(values, reference.itemSize, reference.normalized),
    )
  }

  const indices = new Uint32Array(indexCount)
  let indexCursor = 0
  let vertexOffset = 0
  for (const part of parts) {
    const index = part.geometry.getIndex()!
    const source = index.array
    for (let offset = 0; offset < source.length; offset += 1) {
      indices[indexCursor + offset] = source[offset] + vertexOffset
    }
    indexCursor += source.length
    vertexOffset += (part.geometry.getAttribute('position') as BufferAttribute).count
  }
  merged.setIndex(new BufferAttribute(indices, 1))
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return merged
}

function closestAvailableLod(
  geometries: ReadonlyMap<number, unknown>,
  requested: number,
): number {
  let closest = 0
  let closestDistance = Infinity
  for (const level of geometries.keys()) {
    const distance = Math.abs(level - requested)
    if (distance < closestDistance) {
      closest = level
      closestDistance = distance
    }
  }
  return closest
}

interface PreparedPreviewSample {
  x: number
  y: number
  z: number
  normalX: number
  normalY: number
  normalZ: number
  weight: number
}

function preparePreviewSample(
  sample: PreviewBrush['samples'][number],
): PreparedPreviewSample {
  const length = Math.hypot(
    sample.normal.x,
    sample.normal.y,
    sample.normal.z,
  ) || 1
  return {
    x: sample.x,
    y: sample.y,
    z: sample.z,
    normalX: sample.normal.x / length,
    normalY: sample.normal.y / length,
    normalZ: sample.normal.z / length,
    weight: Math.max(0, sample.weight ?? 1),
  }
}

function applyWeightPreviewToGeometry(
  geometry: BufferGeometry,
  originX: number,
  originZ: number,
  preview: PreviewWeightPaint,
  samples: readonly PreparedPreviewSample[],
  channel: number,
): number {
  if (samples.length === 0) return 0
  const position = geometry.getAttribute('position') as BufferAttribute
  const weights = geometry.getAttribute(
    'terrainPaintWeights',
  ) as BufferAttribute | undefined
  if (!weights) return 0
  const positions = position.array as Float32Array
  const values = weights.array as Uint16Array
  const radius = Math.max(0.001, preview.radius)
  const radiusSquared = radius * radius
  const exponent = 1 + preview.falloff * 4
  const signedStrength =
    preview.strength * (preview.mode === 'subtract' ? -1 : 1)
  let firstChangedVertex = Infinity
  let lastChangedVertex = -1
  let changedVertices = 0

  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const offset = vertex * 3
    const worldX = originX + positions[offset]
    const worldY = positions[offset + 1]
    const worldZ = originZ + positions[offset + 2]
    let influence = 0
    for (const sample of samples) {
      const dx = worldX - sample.x
      const dy = worldY - sample.y
      const dz = worldZ - sample.z
      const distanceSquared = dx * dx + dy * dy + dz * dz
      if (distanceSquared >= radiusSquared) continue
      const radial = 1 - Math.sqrt(distanceSquared) / radius
      influence +=
        smoothstep(0, 1, radial) ** exponent * sample.weight
    }
    if (influence <= 0) continue
    const target = vertex * 4 + channel
    const current = values[target]
    const next = Math.round(
      Math.max(
        0,
        Math.min(1, current / 65_535 + signedStrength * influence),
      ) * 65_535,
    )
    if (next === current) continue
    values[target] = next
    firstChangedVertex = Math.min(firstChangedVertex, vertex)
    lastChangedVertex = vertex
    changedVertices += 1
  }

  if (changedVertices > 0) {
    // Upload only the contiguous vertex span containing the changed weights;
    // untouched section buffers never receive a version bump or GPU upload.
    weights.addUpdateRange(
      firstChangedVertex * 4,
      (lastChangedVertex - firstChangedVertex + 1) * 4,
    )
    weights.needsUpdate = true
  }
  return changedVertices
}

function applyPreviewToGeometry(
  geometry: BufferGeometry,
  anchors: Float32Array,
  originX: number,
  originZ: number,
  preview: PreviewBrush,
  samples: readonly PreparedPreviewSample[],
): number {
  const attribute = geometry.getAttribute('position') as BufferAttribute
  const positions = attribute.array as Float32Array
  const params = previewKernelParams(preview)
  let changed = false
  let maximumDisplacement = 0

  // Section geometry is a few thousand vertices and a dab covers a fraction of
  // it. Rejecting on the dab's own box first keeps the cost of a pointer event
  // proportional to what the brush actually touches rather than to the section.
  let minimumX = Infinity
  let minimumY = Infinity
  let minimumZ = Infinity
  let maximumX = -Infinity
  let maximumY = -Infinity
  let maximumZ = -Infinity
  for (const sample of samples) {
    minimumX = Math.min(minimumX, sample.x)
    minimumY = Math.min(minimumY, sample.y)
    minimumZ = Math.min(minimumZ, sample.z)
    maximumX = Math.max(maximumX, sample.x)
    maximumY = Math.max(maximumY, sample.y)
    maximumZ = Math.max(maximumZ, sample.z)
  }
  // Vertices already lifted by earlier dabs of this stroke can still be pulled
  // back by a later one, so the reject box carries a dab's worth of slack.
  const reach = preview.radius + maximumDabDisplacement(params)
  const isHeightfield = preview.domain === 'heightfield'

  for (let offset = 0; offset < positions.length; offset += 3) {
    const startX = positions[offset]
    const startY = positions[offset + 1]
    const startZ = positions[offset + 2]
    const worldX = originX + startX
    const worldZ = originZ + startZ
    if (
      worldX < minimumX - reach ||
      worldX > maximumX + reach ||
      worldZ < minimumZ - reach ||
      worldZ > maximumZ + reach ||
      (!isHeightfield &&
        (startY < minimumY - reach || startY > maximumY + reach))
    ) {
      continue
    }

    previewAnchor.x = originX + anchors[offset]
    previewAnchor.y = anchors[offset + 1]
    previewAnchor.z = originZ + anchors[offset + 2]
    previewPoint.x = worldX
    previewPoint.y = startY
    previewPoint.z = worldZ
    for (const sample of samples) {
      applyBrushDab(previewPoint, params, sample, previewAnchor)
    }

    const dx = previewPoint.x - worldX
    const dy = previewPoint.y - startY
    const dz = previewPoint.z - worldZ
    if (dx === 0 && dy === 0 && dz === 0) continue
    positions[offset] = startX + dx
    positions[offset + 1] = startY + dy
    positions[offset + 2] = startZ + dz
    changed = true
    maximumDisplacement = Math.max(maximumDisplacement, Math.hypot(dx, dy, dz))
  }

  if (!changed) return 0
  attribute.needsUpdate = true
  return maximumDisplacement
}

/** Reused by the vertex loop above; the kernel never retains either. */
const previewPoint: MutablePoint = { x: 0, y: 0, z: 0 }
const previewAnchor: MutablePoint = { x: 0, y: 0, z: 0 }

function previewKernelParams(preview: PreviewBrush): BrushKernelParams {
  return {
    mode: preview.mode,
    domain: preview.domain,
    radius: preview.radius,
    strength: preview.strength,
    falloff: preview.falloff,
    targetY: preview.targetY,
    terraceStep: preview.terraceStep,
    noiseScale: preview.noiseScale,
    noiseSeed: preview.noiseSeed,
    accumulate: preview.accumulate,
  }
}

function expandPreviewBounds(
  geometry: BufferGeometry,
  amount: number,
): void {
  geometry.boundingBox?.expandByScalar(amount)
  if (geometry.boundingSphere) geometry.boundingSphere.radius += amount
}

function createTerrainMesh(
  section: TerrainSection,
  geometry: BufferGeometry,
  material: Material,
  sectionSize: number,
): Mesh {
  const mesh = new Mesh(geometry, material)
  mesh.position.set(section.key.x * sectionSize, 0, section.key.z * sectionSize)
  mesh.castShadow = false
  mesh.receiveShadow = true
  mesh.frustumCulled = true
  // A section never moves once placed, and recomposing a thousand identical
  // matrices was measurable in the frame profile on its own.
  mesh.matrixAutoUpdate = false
  mesh.updateMatrix()
  mesh.userData.terrainSectionId = section.id
  mesh.name = `terrain-section-${section.id}`
  return mesh
}

function createBoundary(
  section: TerrainSection,
  compiled: CompiledSection,
  material: LineBasicMaterial,
  sectionSize: number,
): LineSegments {
  const line = new LineSegments(
    createBoundaryGeometry(section, compiled, sectionSize),
    material,
  )
  line.position.set(
    section.key.x * sectionSize,
    0,
    section.key.z * sectionSize,
  )
  line.frustumCulled = true
  line.matrixAutoUpdate = false
  line.updateMatrix()
  // Debug boundaries are never a pick target, and testing eight segments each
  // across a thousand sections is real cost on every pointer move.
  line.raycast = () => {}
  line.name = `section-boundary-${section.id}`
  return line
}

function createBoundaryGeometry(
  section: TerrainSection,
  compiled: CompiledSection,
  sectionSize: number,
): BufferGeometry {
  const size = sectionSize
  const y = compiled.bounds.max.y + 1.4
  const positions = new Float32Array([
    0, y, 0, size, y, 0,
    size, y, 0, size, y, size,
    size, y, size, 0, y, size,
    0, y, size, 0, y, 0,
  ])
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.computeBoundingSphere()
  geometry.userData.sectionId = section.id
  return geometry
}
