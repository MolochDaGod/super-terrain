import {
  distanceToAabb,
  expandBounds,
  intersects,
  parseSectionId,
  unionBounds,
  worldToSection,
} from './core/bounds'
import { ExternalStore } from './core/ExternalStore'
import { FrameBudgetScheduler } from './core/FrameBudgetScheduler'
import { WorldCoordinates } from './core/WorldCoordinates'
import {
  EMPTY_METRICS,
  type AABB,
  type CompiledSection,
  type SectionKey,
  type TerrainMetrics,
  type Vec3Like,
} from './core/types'
import {
  DEFAULT_TERRAIN_CONFIG,
  type TerrainConfig,
} from './config'
import { BenchmarkHistory } from './benchmarks/BenchmarkHistory'
import { evaluateHeight } from './compiler/TerrainField'
import { TerrainCompiler } from './compiler/TerrainCompiler'
import {
  createDemoTerrainModifiers,
  upgradeLegacyDemoTerrainModifiers,
} from './demo/createDemoModifiers'
import type { EditorSnapshot, TerrainOverlay } from './editor/EditorStore'
import {
  cameraSectionDistance,
  constrainNeighborLods,
  focusedLodCeiling,
  selectLod,
  selectSourceLod,
} from './lod/LodSelector'
import { ModifierStack } from './modifiers/ModifierStack'
import { EditableMesh } from './mesh/EditableMesh'
import {
  appendBrushPoint,
  createBooleanVolumeModifier,
  createBrushStroke,
  createMaterialSettingsModifier,
  createRemeshModifier,
  createSculptLayerModifier,
  createTunnelModifier,
  createWeightPaintStroke,
} from './modifiers/factories'
import type {
  BooleanSubtractModifier,
  BrushStrokeModifier,
  CsgOperation,
  MaterialSettingsModifier,
  ModifierTransform,
  SculptLayerModifier,
  WeightPaintModifier,
} from './modifiers/types'
import { sampleStrokeSegment } from './modifiers/strokeSampling'
import {
  tunnelPortalDistance,
  updateTunnelPortal,
} from './modifiers/tunnel'
import {
  modifierWorldBounds,
  normalizedTransform,
} from './modifiers/transform'
import { MeshPartition, type TerrainSection } from './partition/MeshPartition'
import { IndexedDbTerrainStorage, type TerrainStorage } from './persistence/TerrainStorage'
import type { TerrainRenderBackend } from './rendering/TerrainRenderBackend'
import { HorizonProxyMask } from './rendering/HorizonProxyMask'
import {
  cloneTerrainMaterialSettings,
  DEFAULT_TERRAIN_MATERIAL_SETTINGS,
  type TerrainMaterialChannel,
  type TerrainMaterialSettings,
  type TerrainPaintChannelId,
} from './rendering/materialSettings'
import { TerrainStreamer, type StreamCandidate } from './streaming/TerrainStreamer'
import type { CsgPrimitive } from './editor/EditorStore'
import { GraniteRockStore } from './rocks/GraniteRockStore'
import {
  generateGraniteRock,
  transformGraniteRockPositions,
} from './rocks/generateGraniteRock'
import { ensureGraniteTopology } from './rocks/graniteTopologyLoader'
import {
  GRANITE_PLANTING_CELLS,
  normalizeGraniteRockParameters,
  normalizeGraniteRockTransform,
  type GraniteRockParameters,
  type GraniteRockTransform,
} from './rocks/types'

export interface TerrainUpdateInput {
  camera: Vec3Like
  viewportHeight: number
  aspect: number
  verticalFovRadians: number
  frameMs: number
  now?: number
}

export type BenchmarkScenario =
  | 'sculpt-torture'
  | 'rebuild-torture'
  | 'streaming-torture'

interface ActiveBenchmark {
  name: BenchmarkScenario
  startedAt: number
  endsAt: number
  lastStepAt: number
  step: number
}

interface TerrainViewSignature {
  cameraX: number
  cameraY: number
  cameraZ: number
  focusX: number
  focusY: number
  focusZ: number
  viewportHeight: number
  aspect: number
  verticalFovRadians: number
}

const BRUSH_FLOW_PER_SECOND = 2.4
const SPATIAL_DAB_WEIGHT = 0.08
const MAX_AUTHORED_DAB_WEIGHT = 0.2
const GRANITE_PLANT_DEPTH_RATIO = 0.06

function compiledGpuBytes(compiled: CompiledSection | undefined): number {
  return compiled?.gpuBytes ?? compiled?.lods.reduce(
    (bytes, lod) => bytes + lod.gpuBytes,
    0,
  ) ?? 0
}

/**
 * Height measuring for planting always uses one fixed grid so that raising a
 * rock's CSG topology tier never blocks placement on a heavy re-extraction.
 */
function plantingRecipe(
  parameters: GraniteRockParameters,
): GraniteRockParameters {
  return { ...parameters, topologyDetail: GRANITE_PLANTING_CELLS }
}

function requestedLevels(minimum: number, count: number): number[] {
  const first = Math.max(0, Math.min(count - 1, Math.round(minimum)))
  return Array.from({ length: count - first }, (_, offset) => first + offset)
}

function sameViewSignature(
  previous: TerrainViewSignature | undefined,
  next: TerrainViewSignature,
): boolean {
  return Boolean(
    previous &&
      previous.cameraX === next.cameraX &&
      previous.cameraY === next.cameraY &&
      previous.cameraZ === next.cameraZ &&
      previous.focusX === next.focusX &&
      previous.focusY === next.focusY &&
      previous.focusZ === next.focusZ &&
      previous.viewportHeight === next.viewportHeight &&
      previous.aspect === next.aspect &&
      previous.verticalFovRadians === next.verticalFovRadians,
  )
}

export type StrokeEndResult = 'committed' | 'cancelled' | 'none'
type ActiveStrokeModifier = BrushStrokeModifier | WeightPaintModifier

export class WorldTerrain {
  readonly config: TerrainConfig
  readonly partition: MeshPartition
  readonly modifiers = new ModifierStack()
  readonly rocks = new GraniteRockStore()
  readonly metrics = new ExternalStore<TerrainMetrics>(EMPTY_METRICS)
  readonly coordinates: WorldCoordinates
  private readonly compiler: TerrainCompiler
  private readonly scheduler: FrameBudgetScheduler
  private readonly streamer: TerrainStreamer
  private readonly storage: TerrainStorage
  private readonly benchmarkHistory = new BenchmarkHistory()
  private renderer?: TerrainRenderBackend
  private activeStroke?: ActiveStrokeModifier
  private activeTunnel?: BooleanSubtractModifier
  private lastStrokePoint?: Vec3Like
  private lastStrokeNormal?: Vec3Like
  private liveStrokePoint?: Vec3Like
  private liveStrokeNormal?: Vec3Like
  private editFocus?: Vec3Like
  private initialized = false
  private initializePromise?: Promise<void>
  private disposed = false
  private overlay: TerrainOverlay = 'none'
  private nextSaveAt = Infinity
  private savedModifierRevision = 0
  private savedRockRevision = 0
  private saveInFlight = false
  private lastMetricsAt = 0
  private schedulingMs = 0
  private activeBenchmark?: ActiveBenchmark
  private latestCamera: Vec3Like = { x: 0, y: 0, z: 0 }
  private viewTarget?: Vec3Like
  private readonly horizonProxyMask: HorizonProxyMask
  private viewSignature?: TerrainViewSignature
  private cachedCandidateMap = new Map<string, StreamCandidate>()
  private terrainStateRevision = 0
  private processedTerrainStateRevision = -1
  private hasPendingTerrainWork = true
  private lastIdleMaintenanceAt = 0

  constructor(
    config: Partial<TerrainConfig> = {},
    storage: TerrainStorage = new IndexedDbTerrainStorage(),
  ) {
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config }
    this.horizonProxyMask = new HorizonProxyMask(
      this.config.worldSize,
      this.config.sectionSize,
    )
    this.storage = storage
    this.partition = new MeshPartition({
      sectionSize: this.config.sectionSize,
      worldSize: this.config.worldSize,
      seed: this.config.seed,
    })
    this.coordinates = new WorldCoordinates(this.config.sectionSize)
    this.scheduler = new FrameBudgetScheduler({
      cpuTerrainMs: this.config.terrainCpuBudgetMs,
      gpuUploadBytes: this.config.maxUploadBytesPerFrame,
      sectionSwaps: this.config.maxSectionSwapsPerFrame,
      targetFrameMs: 1000 / this.config.targetFps,
    })
    this.streamer = new TerrainStreamer(this.config)
    this.compiler = new TerrainCompiler(this.config)
    this.compiler.onResult = (result) => {
      this.terrainStateRevision += 1
      this.hasPendingTerrainWork = true
      const section = this.partition.get(result.key)
      if (!section) return
      if (result.compiled) {
        if (this.partition.acceptCompiled(section, result.compiled)) {
          this.benchmarkHistory.record('compile', result.compiled.metadata.compileMs)
        } else if (section.buildingRevision === result.revision) {
          section.buildState = 'queued'
          section.buildJobId = undefined
          section.buildingRevision = undefined
          section.buildingLod = undefined
        }
      } else if (section.revision === result.revision) {
        section.buildState = 'failed'
        section.error = result.error ?? 'Terrain compilation failed'
        console.error(
          `Terrain section ${section.id} failed to compile: ${section.error}`,
        )
        section.buildJobId = undefined
        section.buildingRevision = undefined
        section.buildingLod = undefined
      }
    }
  }

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise
    this.initializePromise = this.loadPersistedWorld()
    return this.initializePromise
  }

  attachRenderer(renderer: TerrainRenderBackend): void {
    this.renderer = renderer
    this.horizonProxyMask.clear()
    renderer.setOverlay(this.overlay)
    renderer.setMaterialSettings(this.getMaterialSettings())
    // A renderer can be recreated during development or device recovery while
    // the source/compiled world remains alive. Stage existing CPU meshes for
    // budgeted re-upload instead of forcing every section through a recompile.
    for (const section of this.partition.values()) {
      if (section.compiled && !section.pendingCompiled && !renderer.has(section.id)) {
        section.pendingCompiled = section.compiled
      }
    }
    this.terrainStateRevision += 1
    this.hasPendingTerrainWork = true
  }

  detachRenderer(renderer: TerrainRenderBackend): void {
    if (this.renderer === renderer) {
      this.renderer = undefined
      this.horizonProxyMask.clear()
    }
  }

  update(input: TerrainUpdateInput): void {
    if (this.disposed || !this.initialized) return
    const now = input.now ?? performance.now()
    this.latestCamera.x = input.camera.x
    this.latestCamera.y = input.camera.y
    this.latestCamera.z = input.camera.z
    this.scheduler.beginFrame(input.frameMs)
    const scheduleStart = performance.now()
    this.updateBenchmark(now)

    const signature = this.createViewSignature(input)
    const viewUnchanged = sameViewSignature(this.viewSignature, signature)
    this.viewSignature = signature
    const canReuseTerrainState =
      viewUnchanged &&
      this.streamer.isSettled &&
      !this.hasPendingTerrainWork &&
      this.processedTerrainStateRevision === this.terrainStateRevision &&
      this.activeStroke?.type !== 'brush-stroke' &&
      !this.activeTunnel &&
      !this.activeBenchmark

    if (canReuseTerrainState) {
      // Static terrain has no per-frame decisions to make. Timed maintenance
      // still wakes independently, while rendering reuses the compiled meshes,
      // material fields, visibility, LODs and shadow maps verbatim.
      if (now - this.lastIdleMaintenanceAt >= 250) {
        this.lastIdleMaintenanceAt = now
        this.scheduleEvictions(now)
        if (this.renderer) {
          this.scheduler.enqueue({
            id: 'dispose:geometry',
            kind: 'maintenance',
            priority: -100,
            estimatedCpuMs: 0.08,
            run: () => this.renderer?.flushDeferredDisposals(2),
          })
        }
      }
      this.scheduleAutosave(now)
      this.schedulingMs = performance.now() - scheduleStart
      this.scheduler.runFrame()
      this.updateMetrics(input.frameMs, now, this.cachedCandidateMap)
      return
    }

    const budget = this.scheduler.snapshot()
    const candidates = this.streamer.update(
      input.camera,
      budget.qualityScale,
      this.editFocus,
      now,
      this.viewTarget
        ? {
            focus: this.viewTarget,
            verticalFovRadians: input.verticalFovRadians,
            aspect: input.aspect,
          }
        : undefined,
    )
    const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    this.cancelDepartedBuilds(this.cachedCandidateMap, candidateMap)
    this.cachedCandidateMap = candidateMap

    if (this.renderer) {
      for (const section of this.partition.values()) {
        // Preserve stable visibility. The old hide-all/show-desired cycle
        // toggled every resident mesh twice per frame even when the camera had
        // not moved, invalidating cached shadows and scene state for no visual
        // change. Only sections that actually left the visible set are hidden.
        if (
          this.renderer.has(section.id) &&
          candidateMap.get(section.id)?.visible !== true
        ) {
          this.renderer.setVisible(section.id, false)
        }
      }
    }

    for (const candidate of candidates) {
      const existing = this.partition.get(candidate.key)
      const section = existing ?? this.partition.getOrCreate(candidate.key, now)
      if (!existing) {
        this.streamer.touch(section.key, 'SOURCE_RESIDENT', 0, 0, now)
      } else {
        this.streamer.setState(
          section.key,
          section.residency,
          section.compiled?.cpuBytes ?? 0,
          this.renderer?.has(section.id) ? compiledGpuBytes(section.compiled) : 0,
          now,
        )
      }
      section.lastTouched = now
      const minimumLod = this.minimumBuildLod(
        section,
        candidate,
        input,
      )
      section.requestedLod = minimumLod
      this.maybeQueueBuild(section, candidate, minimumLod, now)
      this.maybeScheduleSwap(section, candidate)
      this.renderer?.setSectionState(section)
    }

    this.updateLods(candidates, input)
    this.scheduleEvictions(now)
    this.scheduleAutosave(now)
    if (this.renderer) {
      this.scheduler.enqueue({
        id: 'dispose:geometry',
        kind: 'maintenance',
        priority: -100,
        estimatedCpuMs: 0.08,
        run: () => this.renderer?.flushDeferredDisposals(2),
      })
    }

    this.schedulingMs = performance.now() - scheduleStart
    this.scheduler.runFrame()
    this.horizonProxyMask.update(
      candidateMap.values(),
      (id) => this.renderer?.has(id) === true,
    )
    this.processedTerrainStateRevision = this.terrainStateRevision
    this.hasPendingTerrainWork = this.detectPendingTerrainWork()
    this.updateMetrics(input.frameMs, now, candidateMap)
  }

  beginStroke(
    point: Vec3Like,
    normal: Vec3Like,
    editor: EditorSnapshot,
  ): string | undefined {
    // A physical press owns exactly one brush-stroke modifier. Treat duplicate
    // pointer-down delivery as re-entry into the existing authoring session.
    if (this.activeStroke) return this.activeStroke.id
    if (this.activeTunnel) return this.activeTunnel.id
    this.editFocus = { ...point }
    if (editor.tool === 'select') return
    if (editor.tool === 'tunnel') {
      const portal = { ...point, normal: { ...normal } }
      const modifier = createTunnelModifier({
        start: portal,
        end: portal,
        radius: editor.tunnelRadius,
        depth: editor.tunnelDepth,
      })
      this.modifiers.add(modifier)
      this.activeTunnel = modifier
      return modifier.id
    }
    if (editor.tool === 'remesh') {
      const modifier = createRemeshModifier({
        center: point,
        radius: editor.brushRadius,
        targetEdgeLength: editor.targetEdgeLength,
      })
      this.modifiers.add(modifier)
      this.invalidate(modifier.bounds)
      this.markPersistenceDirty()
      return modifier.id
    }
    const isPaint = editor.tool === 'paint'
    const strokeNormal =
      !isPaint && editor.brushDomain === 'heightfield'
        ? { x: 0, y: 1, z: 0 }
        : normal
    const sculptLayers = this.getSculptLayers()
    const sculptLayerId = sculptLayers.some(
      (layer) => layer.id === editor.activeSculptLayerId,
    )
      ? editor.activeSculptLayerId
      : sculptLayers[0]?.id
    const stroke: ActiveStrokeModifier = editor.tool === 'paint'
      ? createWeightPaintStroke({
          point,
          normal: strokeNormal,
          channel: editor.activePaintChannel,
          mode: editor.paintMode,
          radius: editor.brushRadius,
          strength: editor.brushStrength,
          falloff: editor.brushFalloff,
          sampleWeight: SPATIAL_DAB_WEIGHT,
        })
      : createBrushStroke({
          point,
          normal: strokeNormal,
          domain: editor.brushDomain,
          mode: editor.tool,
          radius: editor.brushRadius,
          strength: editor.brushStrength,
          falloff: editor.brushFalloff,
          targetY:
            editor.tool === 'flatten' || editor.tool === 'scrape'
              ? point.y
              : undefined,
          terraceStep: editor.terraceStep,
          noiseScale: editor.noiseScale,
          sculptLayerId,
          sampleWeight: SPATIAL_DAB_WEIGHT,
        })
    this.modifiers.add(stroke)
    this.activeStroke = stroke
    this.lastStrokePoint = { ...point }
    this.lastStrokeNormal = { ...strokeNormal }
    this.liveStrokePoint = { ...point }
    this.liveStrokeNormal = { ...strokeNormal }
    if (stroke.type === 'brush-stroke') this.invalidate(stroke.bounds)
    this.forceEditingLod(point, stroke.radius)
    this.applyPreview(stroke, [stroke.points[0]])
    return stroke.id
  }

  continueStroke(point: Vec3Like, normal: Vec3Like): void {
    if (this.activeTunnel) {
      updateTunnelPortal(this.activeTunnel, 1, point, normal)
      this.editFocus = { ...point }
      this.modifiers.touch()
      return
    }
    const stroke = this.activeStroke
    if (!stroke || !this.lastStrokePoint || !this.lastStrokeNormal) return
    const spacing = Math.max(0.35, stroke.radius * 0.05)
    const strokeNormal =
      stroke.type === 'brush-stroke' && stroke.domain === 'heightfield'
        ? { x: 0, y: 1, z: 0 }
        : normal
    this.liveStrokePoint = { ...point }
    this.liveStrokeNormal = { ...strokeNormal }
    this.editFocus = { ...point }
    this.forceEditingLod(point, stroke.radius)
    const samples = sampleStrokeSegment(
      this.lastStrokePoint,
      point,
      this.lastStrokeNormal,
      strokeNormal,
      spacing,
      SPATIAL_DAB_WEIGHT,
    )
    if (samples.length === 0) return
    let dirtyBounds: AABB | undefined
    for (const sample of samples) {
      dirtyBounds = unionBounds(
        dirtyBounds,
        appendBrushPoint(stroke, sample, sample.normal, sample.weight),
      )
    }
    if (stroke.type === 'brush-stroke') this.modifiers.touch()
    const latest = samples.at(-1)!
    this.lastStrokePoint = { x: latest.x, y: latest.y, z: latest.z }
    this.lastStrokeNormal = { ...latest.normal }
    if (stroke.type === 'brush-stroke') this.invalidate(dirtyBounds!)
    this.applyPreview(stroke, samples)
  }

  endStroke(): StrokeEndResult {
    if (this.activeTunnel) {
      const tunnel = this.activeTunnel
      this.activeTunnel = undefined
      if (tunnelPortalDistance(tunnel) < Math.max(2, tunnel.radius * 1.25)) {
        this.modifiers.remove(tunnel.id)
        return 'cancelled'
      }
      this.invalidate(tunnel.bounds)
      this.markPersistenceDirty()
      return 'committed'
    }
    const hadStroke = Boolean(this.activeStroke)
    if (this.activeStroke) {
      if (this.activeStroke.type === 'weight-paint') {
        // Painting already mutated the resident GPU attributes directly. Only
        // now dirty the authoritative sections and launch one worker rebuild.
        this.invalidate(this.activeStroke.bounds)
      }
      this.modifiers.touch()
      this.markPersistenceDirty()
    }
    this.activeStroke = undefined
    this.lastStrokePoint = undefined
    this.lastStrokeNormal = undefined
    this.liveStrokePoint = undefined
    this.liveStrokeNormal = undefined
    return hadStroke ? 'committed' : 'none'
  }

  pauseActiveStroke(): void {
    this.liveStrokePoint = undefined
    this.liveStrokeNormal = undefined
  }

  advanceActiveStroke(deltaSeconds: number): void {
    const stroke = this.activeStroke
    const point = this.liveStrokePoint
    const normal = this.liveStrokeNormal
    if (!stroke || !point || !normal) return
    const flowWeight = Math.min(Math.max(deltaSeconds, 0), 1 / 30) * BRUSH_FLOW_PER_SECOND
    if (flowWeight <= 0) return
    let remainingWeight = flowWeight
    const latest = stroke.points.at(-1)
    if (latest) {
      const applied = Math.min(
        remainingWeight,
        Math.max(0, MAX_AUTHORED_DAB_WEIGHT - latest.weight),
      )
      latest.weight += applied
      remainingWeight -= applied
    }
    let appended = false
    while (remainingWeight > 1e-6) {
      const weight = Math.min(remainingWeight, MAX_AUTHORED_DAB_WEIGHT)
      appendBrushPoint(stroke, point, normal, weight)
      remainingWeight -= weight
      appended = true
    }
    if (appended) {
      this.lastStrokePoint = { ...point }
      this.lastStrokeNormal = { ...normal }
      if (stroke.type === 'brush-stroke') this.modifiers.touch()
    }
    this.applyPreview(stroke, [
      {
        ...point,
        normal: { ...normal },
        weight: flowWeight,
      },
    ])
  }

  setOverlay(overlay: TerrainOverlay): void {
    this.overlay = overlay
    this.renderer?.setOverlay(overlay)
  }

  getSculptLayers(): SculptLayerModifier[] {
    return this.modifiers
      .snapshot()
      .filter(
        (modifier): modifier is SculptLayerModifier =>
          modifier.type === 'sculpt-layer',
      )
  }

  addSculptLayer(name = `Sculpt ${this.getSculptLayers().length + 1}`): string {
    const layer = this.modifiers.add(createSculptLayerModifier(name))
    this.markPersistenceDirty()
    return layer.id
  }

  updateSculptLayer(
    id: string,
    values: Partial<Pick<SculptLayerModifier, 'name' | 'opacity' | 'enabled'>>,
  ): boolean {
    const layer = this.modifiers.get(id)
    if (!layer || layer.type !== 'sculpt-layer') return false
    const affected = this.sculptLayerBounds(id)
    if (values.name !== undefined) layer.name = values.name.trim() || 'Sculpt'
    if (values.opacity !== undefined) {
      layer.opacity = Math.max(0, Math.min(1, values.opacity))
    }
    if (values.enabled !== undefined) layer.enabled = values.enabled
    this.modifiers.touch()
    if (affected) this.invalidate(affected)
    this.markPersistenceDirty()
    return true
  }

  removeSculptLayer(id: string): boolean {
    const layers = this.getSculptLayers()
    if (layers.length <= 1 || !layers.some((layer) => layer.id === id)) {
      return false
    }
    const affected = this.sculptLayerBounds(id)
    for (const modifier of this.modifiers.snapshot()) {
      if (modifier.type === 'brush-stroke' && modifier.sculptLayerId === id) {
        this.modifiers.remove(modifier.id)
      }
    }
    this.modifiers.remove(id)
    if (affected) this.invalidate(affected)
    this.markPersistenceDirty()
    return true
  }

  getMaterialSettings(): TerrainMaterialSettings {
    const material = this.modifiers
      .snapshot()
      .find(
        (modifier): modifier is MaterialSettingsModifier =>
          modifier.type === 'material-settings',
      )
    return cloneTerrainMaterialSettings(
      material?.settings ?? DEFAULT_TERRAIN_MATERIAL_SETTINGS,
    )
  }

  updateMaterialChannel(
    id: TerrainPaintChannelId,
    values: Partial<Pick<TerrainMaterialChannel, 'name' | 'color' | 'roughness'>>,
  ): boolean {
    let material = this.modifiers.get('terrain-material-settings')
    if (!material || material.type !== 'material-settings') {
      material = this.modifiers.add(createMaterialSettingsModifier())
    }
    const channel = material.settings.channels.find((item) => item.id === id)
    if (!channel) return false
    if (values.name !== undefined) channel.name = values.name.trim() || channel.name
    if (values.color !== undefined) {
      channel.color = Math.max(0, Math.min(0xffffff, Math.round(values.color)))
    }
    if (values.roughness !== undefined) {
      channel.roughness = Math.max(0.05, Math.min(1, values.roughness))
    }
    this.modifiers.touch()
    this.renderer?.setMaterialSettings(material.settings)
    this.markPersistenceDirty()
    return true
  }

  addGraniteRock(
    parameters: GraniteRockParameters,
    surfacePoint: Vec3Like,
  ): string {
    const normalized = normalizeGraniteRockParameters(parameters)
    const mesh = generateGraniteRock(plantingRecipe(normalized))
    const localHeight = mesh.bounds.max.y - mesh.bounds.min.y
    const rock = this.rocks.create({
      parameters: normalized,
      transform: {
        position: {
          x: surfacePoint.x,
          y:
            surfacePoint.y -
            mesh.bounds.min.y -
            localHeight * GRANITE_PLANT_DEPTH_RATIO,
          z: surfacePoint.z,
        },
        rotation: {
          x: 0,
          y: ((normalized.seed * 0.618_033_988_75) % 1) * Math.PI * 2,
          z: 0,
        },
        scale: { x: 1, y: 1, z: 1 },
      },
    })
    this.markPersistenceDirty()
    return rock.id
  }

  updateGraniteRockParameters(
    id: string,
    parameters: GraniteRockParameters,
  ): boolean {
    const rock = this.rocks.get(id)
    if (!rock) return false
    const normalized = normalizeGraniteRockParameters(parameters)
    const previousMesh = generateGraniteRock(plantingRecipe(rock.parameters))
    const nextMesh = generateGraniteRock(plantingRecipe(normalized))
    const nextTransform = normalizeGraniteRockTransform(rock.transform)
    // Keep an upright rock planted while its source recipe or scale changes. Once a
    // user has pitched or rolled it, preserving the authored pivot is safer.
    if (
      Math.abs(nextTransform.rotation.x) < 1e-5 &&
      Math.abs(nextTransform.rotation.z) < 1e-5
    ) {
      const previousHeight = previousMesh.bounds.max.y - previousMesh.bounds.min.y
      const nextHeight = nextMesh.bounds.max.y - nextMesh.bounds.min.y
      nextTransform.position.y +=
        (
          previousMesh.bounds.min.y +
          previousHeight * GRANITE_PLANT_DEPTH_RATIO -
          nextMesh.bounds.min.y -
          nextHeight * GRANITE_PLANT_DEPTH_RATIO
        ) * nextTransform.scale.y
    }
    this.rocks.updateParameters(id, normalized)
    this.rocks.updateTransform(id, nextTransform)
    this.markPersistenceDirty()
    return true
  }

  updateGraniteRockTransform(
    id: string,
    transform: GraniteRockTransform,
  ): boolean {
    if (!this.rocks.updateTransform(id, transform)) return false
    this.markPersistenceDirty()
    return true
  }

  setGraniteRockVisible(id: string, visible: boolean): boolean {
    if (!this.rocks.setVisible(id, visible)) return false
    this.markPersistenceDirty()
    return true
  }

  removeGraniteRock(id: string): boolean {
    if (!this.rocks.remove(id)) return false
    this.markPersistenceDirty()
    return true
  }

  /**
   * Copies the selected rock's current world-space triangles into a live exact
   * CSG modifier. Later edits to the scene rock do not mutate this snapshot.
   */
  async applyGraniteRockAsCsg(
    id: string,
    operation: CsgOperation,
  ): Promise<string> {
    const rock = this.rocks.get(id)
    if (!rock) throw new Error('Select a granite rock before applying CSG')
    // The chosen tier decides how much fine worley fracture the cutter carries.
    // Extracting it can take seconds, so warm the cache off the main thread
    // before the synchronous snapshot below reads it.
    await ensureGraniteTopology(rock.parameters)
    const mesh = generateGraniteRock(rock.parameters)
    const modifier = this.modifiers.add(
      createBooleanVolumeModifier({
        operation,
        volumes: [{
          kind: 'mesh',
          positions: transformGraniteRockPositions(
            mesh.positions,
            rock.transform,
          ),
          indices: Array.from(mesh.indices),
          surface: 'none',
        }],
      }),
    )
    this.rocks.setVisible(id, false)
    this.invalidate(modifier.bounds)
    this.markPersistenceDirty()
    return modifier.id
  }

  addCsgPrimitive(
    kind: CsgPrimitive,
    operation: CsgOperation,
    center: Vec3Like,
    size: number,
  ): string {
    const safeSize = Math.max(0.5, size)
    const half = safeSize * 0.5
    const volume = kind === 'sphere'
      ? {
          kind: 'ellipsoid' as const,
          center: { ...center },
          radii: { x: half, y: half, z: half },
          forward: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 1, z: 0 },
          surface: 'none' as const,
        }
      : kind === 'capsule'
        ? {
            kind: 'capsule' as const,
            start: { x: center.x, y: center.y - half * 0.65, z: center.z },
            end: { x: center.x, y: center.y + half * 0.65, z: center.z },
            radius: half * 0.55,
            surface: 'none' as const,
          }
        : {
            kind: 'box' as const,
            center: { ...center },
            halfExtents: { x: half, y: half, z: half },
            forward: { x: 1, y: 0, z: 0 },
            up: { x: 0, y: 1, z: 0 },
            surface: 'none' as const,
          }
    const modifier = this.modifiers.add(
      createBooleanVolumeModifier({ volumes: [volume], operation }),
    )
    this.invalidate(modifier.bounds)
    this.markPersistenceDirty()
    return modifier.id
  }

  addCsgMesh(
    positions: readonly number[],
    indices: readonly number[],
    operation: CsgOperation,
    center: Vec3Like,
  ): string {
    if (positions.length < 9 || positions.length % 3 !== 0) {
      throw new Error('Imported CSG mesh has no valid vertices')
    }
    if (indices.length < 3 || indices.length % 3 !== 0) {
      throw new Error('Imported CSG mesh has no valid triangles')
    }
    if (
      positions.some((value) => !Number.isFinite(value)) ||
      indices.some(
        (value) =>
          !Number.isInteger(value) || value < 0 || value >= positions.length / 3,
      )
    ) {
      throw new Error('Imported CSG mesh contains invalid geometry')
    }
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (let offset = 0; offset < positions.length; offset += 3) {
      minX = Math.min(minX, positions[offset])
      minY = Math.min(minY, positions[offset + 1])
      minZ = Math.min(minZ, positions[offset + 2])
      maxX = Math.max(maxX, positions[offset])
      maxY = Math.max(maxY, positions[offset + 1])
      maxZ = Math.max(maxZ, positions[offset + 2])
    }
    const sourceCenter = {
      x: (minX + maxX) * 0.5,
      y: (minY + maxY) * 0.5,
      z: (minZ + maxZ) * 0.5,
    }
    const worldPositions = positions.map((value, index) => {
      const axis = index % 3
      return value -
        (axis === 0 ? sourceCenter.x : axis === 1 ? sourceCenter.y : sourceCenter.z) +
        (axis === 0 ? center.x : axis === 1 ? center.y : center.z)
    })
    const modifier = this.modifiers.add(
      createBooleanVolumeModifier({
        operation,
        volumes: [{
          kind: 'mesh',
          positions: worldPositions,
          indices: [...indices],
          surface: 'none',
        }],
      }),
    )
    this.invalidate(modifier.bounds)
    this.markPersistenceDirty()
    return modifier.id
  }

  updateCsgOperation(id: string, operation: CsgOperation): boolean {
    const modifier = this.modifiers.get(id)
    if (!modifier || modifier.type !== 'boolean-volume') return false
    if (modifier.operation === operation) return true
    modifier.operation = operation
    this.modifiers.touch()
    this.invalidate(modifier.bounds)
    this.markPersistenceDirty()
    return true
  }

  setViewTarget(target: Vec3Like): void {
    if (
      this.viewTarget &&
      this.viewTarget.x === target.x &&
      this.viewTarget.y === target.y &&
      this.viewTarget.z === target.z
    ) {
      return
    }
    if (this.viewTarget) {
      this.viewTarget.x = target.x
      this.viewTarget.y = target.y
      this.viewTarget.z = target.z
    } else {
      this.viewTarget = { ...target }
    }
  }

  getHorizonProxyMask(): Readonly<HorizonProxyMask> {
    return this.horizonProxyMask
  }

  updateModifierTransform(id: string, transform: ModifierTransform): boolean {
    const modifier = this.modifiers.get(id)
    if (!modifier) return false
    const previousBounds = modifier.bounds
    modifier.transform = normalizedTransform(transform)
    modifier.bounds = modifierWorldBounds(modifier)
    this.modifiers.touch()
    this.invalidate(unionBounds(previousBounds, modifier.bounds))
    this.markPersistenceDirty()
    return true
  }

  updateTunnelShape(
    id: string,
    values: Partial<Pick<BooleanSubtractModifier, 'radius' | 'depth'>>,
  ): boolean {
    const modifier = this.modifiers.get(id)
    if (!modifier || modifier.type !== 'boolean-subtract') return false
    const previousBounds = modifier.bounds
    if (values.radius !== undefined) modifier.radius = Math.max(0.25, values.radius)
    if (values.depth !== undefined) modifier.depth = Math.max(0.25, values.depth)
    modifier.bounds = modifierWorldBounds(modifier)
    this.modifiers.touch()
    this.invalidate(unionBounds(previousBounds, modifier.bounds))
    this.markPersistenceDirty()
    return true
  }

  setModifierEnabled(id: string, enabled: boolean): boolean {
    const modifier = this.modifiers.get(id)
    if (!modifier || modifier.enabled === enabled) return false
    if (modifier.type === 'sculpt-layer') {
      return this.updateSculptLayer(id, { enabled })
    }
    if (modifier.type === 'material-settings') return false
    modifier.enabled = enabled
    this.modifiers.touch()
    this.invalidate(modifier.bounds)
    this.markPersistenceDirty()
    return true
  }

  removeModifier(id: string): boolean {
    const removed = this.modifiers.remove(id)
    if (!removed) return false
    this.invalidate(removed.bounds)
    this.markPersistenceDirty()
    return true
  }

  startBenchmark(name: BenchmarkScenario): void {
    const now = performance.now()
    this.activeBenchmark = {
      name,
      startedAt: now,
      endsAt: now + 7_000,
      lastStepAt: 0,
      step: 0,
    }
  }

  async save(): Promise<void> {
    const modifierRevision = this.modifiers.sourceRevision
    const rockRevision = this.rocks.sourceRevision
    await this.storage.save(
      'default',
      this.modifiers.snapshot(),
      this.rocks.snapshot(),
    )
    this.savedModifierRevision = modifierRevision
    this.savedRockRevision = rockRevision
    if (
      modifierRevision === this.modifiers.sourceRevision &&
      rockRevision === this.rocks.sourceRevision
    ) {
      this.nextSaveAt = Infinity
    }
  }

  async resetEdits(): Promise<void> {
    await this.storage.clear('default')
    this.modifiers.clear()
    this.rocks.clear()
    this.installDemoModifiers()
    this.ensureDocumentModifiers()
    this.renderer?.setMaterialSettings(this.getMaterialSettings())
    const now = performance.now()
    for (const section of this.partition.values()) {
      this.partition.markDirty(section, section.bounds, now)
    }
    this.terrainStateRevision += 1
    this.hasPendingTerrainWork = true
    this.savedModifierRevision = this.modifiers.sourceRevision
    this.savedRockRevision = this.rocks.sourceRevision
    this.nextSaveAt = Infinity
  }

  sampleHeight(x: number, z: number): number {
    return evaluateHeight(
      x,
      z,
      this.config.seed,
      this.modifiers.snapshot(),
    )
  }

  /**
   * Installs a section-local arbitrary mesh as authoritative source topology.
   * Ownership transfers to WorldTerrain; use getSectionMesh() for a safe copy.
   */
  replaceSectionMesh(key: SectionKey, mesh: EditableMesh): number {
    const current = this.partition.get(key)
    const projectedBytes =
      this.partition.editableMeshBytes -
      (current?.source.byteLength ?? 0) +
      mesh.byteLength
    if (projectedBytes > this.config.maxEditableMeshBytes) {
      throw new Error(
        `Editable mesh budget exceeded (${projectedBytes} > ${this.config.maxEditableMeshBytes} bytes)`,
      )
    }
    if (current?.buildState === 'building') this.cancelBuild(current)
    const section = this.partition.replaceSourceMesh(key, mesh)
    section.buildState = 'queued'
    this.terrainStateRevision += 1
    this.hasPendingTerrainWork = true
    return section.revision
  }

  restoreProceduralSection(key: SectionKey): number {
    const current = this.partition.get(key)
    if (current?.buildState === 'building') this.cancelBuild(current)
    const section = this.partition.restoreProceduralSource(key)
    section.buildState = 'queued'
    this.terrainStateRevision += 1
    this.hasPendingTerrainWork = true
    return section.revision
  }

  getSectionMesh(key: SectionKey): EditableMesh | undefined {
    return this.partition.get(key)?.source.cloneMesh()
  }

  get logicalSectionCount(): number {
    const width = Math.ceil(this.config.worldSize / this.config.sectionSize)
    return width * width
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.compiler.dispose()
    this.scheduler.clear()
  }

  private async loadPersistedWorld(): Promise<void> {
    try {
      const [saved, savedRocks] = await Promise.all([
        this.storage.load('default'),
        this.storage.loadRocks?.('default') ?? Promise.resolve(undefined),
      ])
      const upgraded = saved?.length
        ? upgradeLegacyDemoTerrainModifiers(saved, this.config.seed)
        : undefined
      if (upgraded) {
        this.modifiers.replace(upgraded)
        await this.storage.save(
          'default',
          this.modifiers.snapshot(),
          savedRocks ?? [],
        )
      } else if (saved && saved.length > 0) {
        this.modifiers.replace(saved)
      } else {
        this.installDemoModifiers()
      }
      this.rocks.replace(savedRocks ?? [])
      this.ensureDocumentModifiers()
      this.renderer?.setMaterialSettings(this.getMaterialSettings())
      this.savedModifierRevision = this.modifiers.sourceRevision
      this.savedRockRevision = this.rocks.sourceRevision
    } finally {
      this.initialized = true
    }
  }

  private installDemoModifiers(): void {
    for (const modifier of createDemoTerrainModifiers(this.config.seed)) {
      this.modifiers.add(modifier)
    }
  }

  private ensureDocumentModifiers(): void {
    const snapshot = this.modifiers.snapshot()
    if (!snapshot.some((modifier) => modifier.type === 'sculpt-layer')) {
      this.modifiers.add(createSculptLayerModifier('Base sculpt'))
    }
    if (!snapshot.some((modifier) => modifier.type === 'material-settings')) {
      this.modifiers.add(createMaterialSettingsModifier())
    }
  }

  private sculptLayerBounds(id: string): AABB | undefined {
    let result: AABB | undefined
    for (const modifier of this.modifiers.snapshot()) {
      if (modifier.type !== 'brush-stroke' || modifier.sculptLayerId !== id) {
        continue
      }
      result = result ? unionBounds(result, modifier.bounds) : modifier.bounds
    }
    return result
  }

  private invalidate(bounds: AABB): void {
    this.partition.invalidateBounds(bounds, this.config.operationHalo)
    this.terrainStateRevision += 1
    this.hasPendingTerrainWork = true
  }

  private createViewSignature(input: TerrainUpdateInput): TerrainViewSignature {
    const focus = this.viewTarget ?? input.camera
    return {
      cameraX: input.camera.x,
      cameraY: input.camera.y,
      cameraZ: input.camera.z,
      focusX: focus.x,
      focusY: focus.y,
      focusZ: focus.z,
      viewportHeight: input.viewportHeight,
      aspect: input.aspect,
      verticalFovRadians: input.verticalFovRadians,
    }
  }

  private detectPendingTerrainWork(): boolean {
    for (const section of this.partition.values()) {
      if (!this.streamer.isDesired(section.key)) continue
      if (
        section.buildState === 'queued' ||
        section.buildState === 'building' ||
        section.buildState === 'failed' ||
        section.pendingCompiled
      ) {
        return true
      }
    }
    return false
  }

  private maybeQueueBuild(
    section: TerrainSection,
    candidate: StreamCandidate,
    minimumLod: number,
    now: number,
  ): void {
    if (
      ((this.activeStroke && intersects(section.bounds, this.activeStroke.bounds)) ||
        (this.activeTunnel && intersects(section.bounds, this.activeTunnel.bounds)))
    ) {
      return
    }
    if (
      section.buildState === 'building' &&
      section.buildingRevision === section.revision &&
      (section.buildingLod ?? 0) <= minimumLod
    ) {
      this.compiler.reprioritize(
        section.key,
        section.revision,
        candidate.priority,
      )
      return
    }

    // Let an already finished coarse result become visible before asking for a
    // finer replacement. Committing and starting another build in the same
    // frame would make commitPending overwrite the new building state.
    if (
      section.pendingCompiled?.sourceRevision === section.revision
    ) {
      return
    }

    const compiledMinimumLod =
      section.compiled?.sourceRevision === section.revision
        ? (section.compiled.lods[0]?.level ?? Infinity)
        : Infinity
    const needsBuild =
      section.buildState === 'queued' ||
      section.buildState === 'failed' ||
      (section.buildState === 'building' &&
        section.buildingRevision !== section.revision) ||
      minimumLod < compiledMinimumLod
    if (!needsBuild) return
    const coalesceDelay = section.compiled ? 95 : 0
    if (now - section.dirtySince < coalesceDelay) return
    if (section.buildState === 'building') {
      this.compiler.cancel(
        section.key,
        section.buildingRevision ?? section.revision,
      )
    }
    const modifiers = this.modifiers.query(
      expandBounds(section.bounds, this.config.operationHalo),
    )
    const jobId = this.compiler.queue(
      section.key,
      section.revision,
      candidate.priority,
      modifiers,
      requestedLevels(minimumLod, this.config.lodResolutions.length),
      section.source.createCompileSnapshot(
        section.key,
        this.config.sectionSize,
        {
          minSection: this.partition.minSection,
          maxSection: this.partition.maxSection,
        },
      ),
    )
    this.partition.markBuilding(section, jobId, minimumLod)
  }

  private minimumBuildLod(
    section: TerrainSection,
    candidate: StreamCandidate,
    input: TerrainUpdateInput,
  ): number {
    if (section.dirtyRegion) return 0
    const lastLevel = this.config.lodResolutions.length - 1
    if (!candidate.visible) return lastLevel
    const cameraDistance = cameraSectionDistance(
      candidate.key,
      input.camera,
      this.config.sectionSize,
    )
    const screenLod = selectSourceLod({
      lodResolutions: this.config.lodResolutions,
      sectionSize: this.config.sectionSize,
      distance: Math.max(
        this.config.sectionSize * 0.5,
        candidate.distance * this.config.sectionSize,
      ),
      viewportHeight: input.viewportHeight,
      verticalFovRadians: input.verticalFovRadians,
      // Worker source resolution must be stable for a stable view. The frame
      // scheduler's quality scale can drop during startup and then recover;
      // feeding that transient value into compilation caused a second wave of
      // finer jobs for sections that were already rendered. Runtime LOD choice
      // can still follow frame pressure, while workers refine only when camera
      // distance or authored terrain actually changes.
      errorTolerancePixels: this.config.baseLodErrorPixels,
    })
    return Math.min(
      screenLod,
      focusedLodCeiling(
        cameraDistance,
        this.config.lod0FocusRadiusSections,
        lastLevel,
      ),
    )
  }

  private cancelDepartedBuilds(
    previous: ReadonlyMap<string, StreamCandidate>,
    next: ReadonlyMap<string, StreamCandidate>,
  ): void {
    for (const id of previous.keys()) {
      if (next.has(id)) continue
      const previousCandidate = previous.get(id)
      if (!previousCandidate) continue
      const section = this.partition.get(previousCandidate.key)
      if (!section || section.buildState !== 'building') continue
      this.compiler.cancel(section.key, section.buildingRevision)
      section.buildJobId = undefined
      section.buildingRevision = undefined
      section.buildingLod = undefined
      section.buildState =
        section.compiled?.sourceRevision === section.revision &&
        !section.dirtyRegion
          ? 'clean'
          : 'queued'
    }
  }

  private maybeScheduleSwap(
    section: TerrainSection,
    candidate: StreamCandidate,
  ): void {
    const pending = section.pendingCompiled
    if (!pending || pending.sourceRevision !== section.revision || !this.renderer) return
    this.scheduler.enqueue({
      id: `swap:${section.id}:${section.revision}`,
      kind: 'swap',
      priority: candidate.priority + 3_000,
      estimatedCpuMs: 0.42,
      uploadBytes: compiledGpuBytes(pending),
      swaps: 1,
      run: () => {
        if (
          this.partition.get(section.key) !== section ||
          !this.streamer.isDesired(section.key)
        ) {
          return
        }
        const compiled = this.partition.commitPending(section)
        if (!compiled || !this.renderer) return
        this.renderer.upload(section, compiled)
        const visible = this.streamer.isVisible(section.key)
        this.renderer.setVisible(section.id, visible)
        section.residency = visible ? 'VISIBLE' : 'GPU_RESIDENT'
        this.streamer.setState(
          section.key,
          section.residency,
          compiled.cpuBytes,
          compiledGpuBytes(compiled),
        )
      },
    })
  }

  private updateLods(
    candidates: StreamCandidate[],
    input: TerrainUpdateInput,
  ): void {
    if (!this.renderer) return
    const nodes = []
    for (const candidate of candidates) {
      const section = this.partition.get(candidate.key)
      if (!section || !section.compiled || !this.renderer.has(section.id)) continue
      const centerX = (section.bounds.min.x + section.bounds.max.x) * 0.5
      const centerY = (section.compiled.bounds.min.y + section.compiled.bounds.max.y) * 0.5
      const centerZ = (section.bounds.min.z + section.bounds.max.z) * 0.5
      const distance = Math.hypot(
        input.camera.x - centerX,
        input.camera.y - centerY,
        input.camera.z - centerZ,
      )
      let lod = selectLod({
        lods: section.compiled.lods,
        distance,
        viewportHeight: input.viewportHeight,
        verticalFovRadians: input.verticalFovRadians,
        errorTolerancePixels:
          this.config.baseLodErrorPixels / Math.max(0.48, this.scheduler.snapshot().qualityScale),
        currentLod: section.activeLod,
        focusDistanceSections: cameraSectionDistance(
          candidate.key,
          input.camera,
          this.config.sectionSize,
        ),
        lod0FocusRadiusSections: this.config.lod0FocusRadiusSections,
      })
      const activeBrushTouchesSection = Boolean(
        this.activeStroke &&
        this.liveStrokePoint &&
        distanceToAabb(this.liveStrokePoint, section.bounds) <=
          this.activeStroke.radius,
      )
      if (activeBrushTouchesSection || section.dirtyRegion) lod = 0
      section.requestedLod = lod
      nodes.push({ id: section.id, x: section.key.x, z: section.key.z, lod })
      this.renderer.setVisible(section.id, candidate.visible)
      section.residency = candidate.visible ? 'VISIBLE' : 'GPU_RESIDENT'
      this.streamer.setState(
        section.key,
        section.residency,
        section.compiled.cpuBytes,
        compiledGpuBytes(section.compiled),
      )
    }
    const constrained = constrainNeighborLods(nodes)
    for (const [id, lod] of constrained) this.renderer.setLod(id, lod)
  }

  private forceEditingLod(point: Vec3Like, radius: number): void {
    if (!this.renderer) return
    const minimum = worldToSection(
      point.x - radius,
      point.z - radius,
      this.config.sectionSize,
    )
    const maximum = worldToSection(
      point.x + radius,
      point.z + radius,
      this.config.sectionSize,
    )
    for (let z = minimum.z; z <= maximum.z; z += 1) {
      for (let x = minimum.x; x <= maximum.x; x += 1) {
        const section = this.partition.get({ x, z })
        if (section) this.renderer.setLod(section.id, 0)
      }
    }
  }

  private scheduleEvictions(now: number): void {
    const evictions = this.streamer.collectEvictions(now)
    for (let index = 0; index < Math.min(2, evictions.length); index += 1) {
      const id = evictions[index]
      this.scheduler.enqueue({
        id: `evict:${id}`,
        kind: 'maintenance',
        priority: -50 - index,
        estimatedCpuMs: 0.12,
        run: () => {
          const key = parseSectionId(id)
          if (this.streamer.isDesired(key)) return
          this.compiler.cancel(key)
          this.renderer?.evict(id)
          const section = this.partition.get(key)
          if (section && !section.source.procedural) {
            // Authored source has no durable document store yet. Evict derived
            // CPU/GPU data but retain the authoritative mesh in its budget.
            section.compiled = undefined
            section.pendingCompiled = undefined
            section.buildState = 'queued'
            section.residency = 'SOURCE_RESIDENT'
            section.buildJobId = undefined
            section.buildingRevision = undefined
            section.buildingLod = undefined
          } else {
            this.partition.remove(key)
          }
          this.streamer.evicted(id)
        },
      })
    }
  }

  private applyPreview(
    stroke: ActiveStrokeModifier,
    samples: readonly ActiveStrokeModifier['points'][number][],
  ): void {
    // This mutates only small resident render buffers and must be visible in
    // the very next frame. Authoritative evaluation remains worker-only.
    if (stroke.type === 'weight-paint') {
      this.renderer?.previewWeightPaint({
        channel: stroke.channel,
        mode: stroke.mode,
        samples,
        radius: stroke.radius,
        strength: stroke.strength,
        falloff: stroke.falloff,
      })
    } else {
      this.renderer?.previewBrush({
        mode: stroke.mode,
        domain: stroke.domain,
        samples,
        radius: stroke.radius,
        strength: stroke.strength,
        falloff: stroke.falloff,
        targetY: stroke.targetY,
        terraceStep: stroke.terraceStep,
        noiseScale: stroke.noiseScale,
        noiseSeed: stroke.noiseSeed,
      })
    }
  }

  private markPersistenceDirty(): void {
    this.nextSaveAt = performance.now() + 1_500
  }

  private scheduleAutosave(now: number): void {
    if (
      this.saveInFlight ||
      now < this.nextSaveAt ||
      (this.savedModifierRevision === this.modifiers.sourceRevision &&
        this.savedRockRevision === this.rocks.sourceRevision)
    ) {
      return
    }
    this.scheduler.enqueue({
      id: 'persistence:autosave',
      kind: 'maintenance',
      priority: -1_000,
      estimatedCpuMs: 0.25,
      run: () => {
        this.saveInFlight = true
        const modifierRevision = this.modifiers.sourceRevision
        const rockRevision = this.rocks.sourceRevision
        void this.storage
          .save(
            'default',
            this.modifiers.snapshot(),
            this.rocks.snapshot(),
          )
          .then(() => {
            this.savedModifierRevision = modifierRevision
            this.savedRockRevision = rockRevision
            this.nextSaveAt =
              modifierRevision === this.modifiers.sourceRevision &&
              rockRevision === this.rocks.sourceRevision
                ? Infinity
                : performance.now() + 500
          })
          .finally(() => {
            this.saveInFlight = false
          })
      },
    })
  }

  private updateBenchmark(now: number): void {
    const benchmark = this.activeBenchmark
    if (!benchmark) return
    if (now >= benchmark.endsAt) {
      this.endStroke()
      this.activeBenchmark = undefined
      return
    }
    if (benchmark.name === 'streaming-torture') return
    if (now - benchmark.lastStepAt < 120) return
    benchmark.lastStepAt = now
    const focus = this.editFocus ?? {
      x: this.latestCamera.x - 80,
      y: 20,
      z: this.latestCamera.z - 80,
    }
    const angle = benchmark.step * 0.52
    const point = {
      x: focus.x + Math.cos(angle) * 28,
      y: focus.y,
      z: focus.z + Math.sin(angle) * 28,
    }
    const stroke = createBrushStroke({
      point,
      normal: { x: 0, y: 1, z: 0 },
      mode: benchmark.step % 4 === 0 ? 'lower' : 'raise',
      radius: benchmark.name === 'rebuild-torture' ? 26 : 17,
      strength: 0.22,
      falloff: 0.58,
    })
    this.modifiers.add(stroke)
    this.invalidate(stroke.bounds)
    this.applyPreview(stroke, [stroke.points[0]])
    this.markPersistenceDirty()
    benchmark.step += 1
  }

  private updateMetrics(
    frameMs: number,
    now: number,
    candidates: Map<string, StreamCandidate>,
  ): void {
    if (now - this.lastMetricsAt < 100) return
    this.lastMetricsAt = now
    const scheduler = this.scheduler.snapshot()
    const streaming = this.streamer.snapshot(now)
    const rendering = this.renderer?.stats() ?? {
      gpuBytes: 0,
      residentSections: 0,
      visibleSections: 0,
      triangles: 0,
      trianglesByLod: [0, 0, 0, 0, 0],
    }
    const workers = this.compiler.stats()
    let rebuilding = 0
    for (const section of this.partition.values()) {
      if (
        this.streamer.isDesired(section.key) &&
        (section.buildState === 'building' || section.buildState === 'queued')
      ) {
        rebuilding += 1
      }
    }
    this.metrics.set({
      fps: 1000 / Math.max(1, scheduler.averageFrameMs),
      frameMs,
      averageFrameMs: scheduler.averageFrameMs,
      terrainMainThreadMs: this.scheduler.terrainMainThreadMs,
      terrainSchedulingMs: this.schedulingMs,
      visibleSections: rendering.visibleSections,
      gpuResidentSections: rendering.residentSections,
      sourceResidentSections: streaming.sourceResident,
      compiledCpuSections: streaming.compiledCpu,
      trianglesRendered: rendering.triangles,
      trianglesByLod: rendering.trianglesByLod,
      workerActiveJobs: workers.active,
      workerQueuedJobs: workers.queued,
      staleJobs: workers.stale,
      cancelledJobs: workers.cancelled,
      sectionsRebuilding: rebuilding,
      sectionsSwapped: this.scheduler.swapsThisFrame,
      gpuUploadBytes: this.scheduler.uploadedBytesThisFrame,
      gpuBytes: rendering.gpuBytes,
      cpuBytes: streaming.cpuBytes + this.partition.editableMeshBytes,
      streamLoadsPerSecond: streaming.loadsPerSecond,
      streamEvictionsPerSecond: streaming.evictionsPerSecond,
      qualityScale: scheduler.qualityScale,
      frameBudgetViolations: scheduler.violations,
      activeBenchmark: this.activeBenchmark?.name ?? null,
      compileP50Ms: this.benchmarkHistory.percentile('compile', 0.5),
      compileP95Ms: this.benchmarkHistory.percentile('compile', 0.95),
    })
    void candidates
    void this.initialized
  }

  private cancelBuild(section: TerrainSection): void {
    this.compiler.cancel(section.key, section.buildingRevision)
    section.buildJobId = undefined
    section.buildingRevision = undefined
    section.buildingLod = undefined
  }
}
