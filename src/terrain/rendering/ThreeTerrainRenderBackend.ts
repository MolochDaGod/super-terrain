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
  Vector3,
} from 'three/webgpu'
import { smoothstep } from '../core/bounds'
import type { CompiledSection, SectionId } from '../core/types'
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
  cloneTerrainMaterialSettings,
  DEFAULT_TERRAIN_MATERIAL_SETTINGS,
  paintChannelIndex,
  type TerrainMaterialSettings,
} from './materialSettings'

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
  private readonly scratchPoint = new Vector3()
  private readonly scratchNormal = new Vector3()
  private readonly scratchNormalMatrix = new Matrix3()
  private readonly pendingPreviewRefresh = new Set<BufferGeometry>()
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
    const lods = new Map(
      compiled.lods.map((lod) => [
        lod.level,
        this.createRuntimeLod(
          section,
          lod.level,
          createSectionGeometry(lod, this.sectionSize),
        ),
      ]),
    )
    let runtime = this.runtime.get(section.id)
    if (runtime) {
      this.detachActiveLod(runtime)
      this.deferRuntimeLods(runtime.lods)
      runtime.lods = lods
      runtime.gpuBytes = gpuBytes
      runtime.section = section
      runtime.lod = closestAvailableLod(lods, runtime.lod)
      this.attachActiveLod(runtime)
      this.updateBoundary(runtime, compiled)
    } else {
      const initialLod = closestAvailableLod(
        lods,
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
        lods,
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
    invalidateTerrainShadows()
    return gpuBytes
  }

  has(sectionId: SectionId): boolean {
    return this.runtime.has(sectionId)
  }

  setLod(sectionId: SectionId, lod: number): void {
    const runtime = this.runtime.get(sectionId)
    if (!runtime) return
    const next = closestAvailableLod(runtime.lods, lod)
    if (next === runtime.lod) return
    this.detachActiveLod(runtime)
    runtime.lod = next
    runtime.section.activeLod = next
    this.attachActiveLod(runtime)
    this.applyMaterial(runtime)
    invalidateTerrainShadows()
  }

  setVisible(sectionId: SectionId, visible: boolean): void {
    const runtime = this.runtime.get(sectionId)
    if (!runtime || runtime.visible === visible) return
    runtime.visible = visible
    for (const brick of this.activeBricks(runtime)) {
      brick.mesh.visible = visible
    }
    runtime.boundary.visible = visible && this.overlay !== 'none'
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
  setRenderMode(mode: TerrainRenderMode): void {
    if (this.renderMode === mode) return
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
    previous.dispose()
    invalidateTerrainShadows()
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
    previous.dispose()
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
    invalidateTerrainShadows()
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
        minX,
        minZ,
        preview,
        sectionSamples,
      )
      if (maximumDisplacement > 0) {
        expandPreviewBounds(activeLod.source, maximumDisplacement)
        expandTerrainBrickBounds(activeLod.bricks, maximumDisplacement)
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
        applyWeightPreviewToGeometry(
          runtime.lods.get(runtime.lod)!.source,
          originX,
          originZ,
          preview,
          sectionSamples,
          channel,
        )
      }
    }
  }

  raycast(raycaster: Raycaster): TerrainRaycastHit | undefined {
    const hits = raycaster.intersectObject(this.root, true)
    for (const hit of hits) {
      const id = hit.object.userData.terrainSectionId as SectionId | undefined
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

  flushDeferredDisposals(maxCount: number): void {
    let disposed = 0
    const retained: DeferredGeometry[] = []
    for (const pending of this.deferredDisposals) {
      pending.framesRemaining -= 1
      if (pending.framesRemaining <= 0 && disposed < maxCount) {
        pending.geometry.dispose()
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
    for (const id of [...this.runtime.keys()]) this.evict(id)
    for (const pending of this.deferredDisposals) pending.geometry.dispose()
    this.deferredDisposals.length = 0
    this.root.remove(this.surfaceRoot)
    this.terrainMaterial.dispose()
    this.densityMaterial.dispose()
    for (const material of this.lodMaterials) material.dispose()
    for (const material of Object.values(this.boundaryMaterials)) material.dispose()
  }

  private applyMaterial(runtime: RuntimeSection): void {
    for (const [level, lod] of runtime.lods) {
      const material = this.overlay === 'lod'
        ? this.lodMaterials[level] ?? this.lodMaterials.at(-1)!
        : this.overlay === 'density'
          ? this.densityMaterial
          : this.terrainMaterial.material
      for (const brick of lod.bricks) brick.mesh.material = material
    }
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
    return runtime.lods.get(runtime.lod)?.bricks ?? []
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

  private flushPreviewRefresh(): void {
    if (this.pendingPreviewRefresh.size === 0) return
    for (const geometry of this.pendingPreviewRefresh) {
      geometry.computeVertexNormals()
      const normal = geometry.getAttribute('normal') as BufferAttribute | undefined
      if (normal) normal.needsUpdate = true
    }
    this.pendingPreviewRefresh.clear()
  }
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
  originX: number,
  originZ: number,
  preview: PreviewBrush,
  samples: readonly PreparedPreviewSample[],
): number {
  const attribute = geometry.getAttribute('position') as BufferAttribute
  const positions = attribute.array as Float32Array
  const radiusSquared = preview.radius * preview.radius
  let changed = false
  let maximumDisplacement = 0

  for (let offset = 0; offset < positions.length; offset += 3) {
    const startX = positions[offset]
    const startY = positions[offset + 1]
    const startZ = positions[offset + 2]
    let vertexChanged = false
    for (const sample of samples) {
      const worldX = originX + positions[offset]
      const worldY = positions[offset + 1]
      const worldZ = originZ + positions[offset + 2]
      const dx = worldX - sample.x
      const dy = worldY - sample.y
      const dz = worldZ - sample.z
      const distanceSquared =
        preview.domain === 'heightfield'
          ? dx * dx + dz * dz
          : dx * dx + dy * dy + dz * dz
      if (distanceSquared >= radiusSquared) continue
      const radial = 1 - Math.sqrt(distanceSquared) / preview.radius
      const weight =
        smoothstep(0, 1, radial) ** (0.55 + preview.falloff * 2.4) *
        preview.strength *
        sample.weight

      switch (preview.mode) {
        case 'raise':
        case 'lower': {
          const direction = preview.mode === 'raise' ? 1 : -1
          const displacement = weight * 2.8 * direction
          positions[offset] += sample.normalX * displacement
          positions[offset + 1] += sample.normalY * displacement
          positions[offset + 2] += sample.normalZ * displacement
          break
        }
        case 'flatten': {
          const planeDistance =
            preview.domain === 'heightfield'
              ? worldY - (preview.targetY ?? sample.y)
              : dx * sample.normalX +
                dy * sample.normalY +
                dz * sample.normalZ
          const displacement = -planeDistance * weight * 0.48
          positions[offset] += sample.normalX * displacement
          positions[offset + 1] += sample.normalY * displacement
          positions[offset + 2] += sample.normalZ * displacement
          break
        }
        case 'smooth': {
          const planeDistance =
            preview.domain === 'heightfield'
              ? worldY - sample.y
              : dx * sample.normalX +
                dy * sample.normalY +
                dz * sample.normalZ
          const displacement = -planeDistance * weight * 0.12
          positions[offset] += sample.normalX * displacement
          positions[offset + 1] += sample.normalY * displacement
          positions[offset + 2] += sample.normalZ * displacement
          break
        }
        case 'clay': {
          const displacement = Math.min(
            weight * 3.4,
            radial * preview.strength * 1.5,
          )
          positions[offset] += sample.normalX * displacement
          positions[offset + 1] += sample.normalY * displacement
          positions[offset + 2] += sample.normalZ * displacement
          break
        }
        case 'pinch': {
          const towardX = -dx
          const towardY = -dy
          const towardZ = -dz
          const normalComponent =
            towardX * sample.normalX +
            towardY * sample.normalY +
            towardZ * sample.normalZ
          const amount = Math.max(0, Math.min(0.45, weight * 0.32))
          positions[offset] +=
            (towardX - sample.normalX * normalComponent) * amount
          positions[offset + 1] +=
            (towardY - sample.normalY * normalComponent) * amount
          positions[offset + 2] +=
            (towardZ - sample.normalZ * normalComponent) * amount
          break
        }
        case 'scrape': {
          const planeDistance =
            preview.domain === 'heightfield'
              ? worldY - (preview.targetY ?? sample.y)
              : dx * sample.normalX +
                dy * sample.normalY +
                dz * sample.normalZ
          if (planeDistance <= 0) break
          const displacement =
            -planeDistance * Math.max(0, Math.min(1, weight * 0.7))
          positions[offset] += sample.normalX * displacement
          positions[offset + 1] += sample.normalY * displacement
          positions[offset + 2] += sample.normalZ * displacement
          break
        }
        case 'terrace': {
          const step = Math.max(0.25, preview.terraceStep ?? 4)
          const target = Math.round(worldY / step) * step
          positions[offset + 1] +=
            (target - worldY) * Math.max(0, Math.min(1, weight * 0.65))
          break
        }
        case 'noise': {
          const scale = Math.max(0.15, preview.noiseScale ?? 3)
          const noise = previewHash3(
            Math.floor(worldX / scale),
            Math.floor(worldY / scale),
            Math.floor(worldZ / scale),
            preview.noiseSeed ?? 1,
          ) * 2 - 1
          const displacement = noise * weight * 3.2
          positions[offset] += sample.normalX * displacement
          positions[offset + 1] += sample.normalY * displacement
          positions[offset + 2] += sample.normalZ * displacement
          break
        }
      }
      changed = true
      vertexChanged = true
    }
    if (vertexChanged) {
      maximumDisplacement = Math.max(
        maximumDisplacement,
        Math.hypot(
          positions[offset] - startX,
          positions[offset + 1] - startY,
          positions[offset + 2] - startZ,
        ),
      )
    }
  }

  if (!changed) return 0
  attribute.needsUpdate = true
  return maximumDisplacement
}

function previewHash3(x: number, y: number, z: number, seed: number): number {
  let value =
    Math.imul(x, 374_761_393) ^
    Math.imul(y, 668_265_263) ^
    Math.imul(z, 2_147_483_647) ^
    seed
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177)
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295
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
