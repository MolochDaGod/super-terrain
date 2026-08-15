import { expandBounds, parseSectionId } from './core/bounds'
import { ExternalStore } from './core/ExternalStore'
import { FrameBudgetScheduler } from './core/FrameBudgetScheduler'
import { WorldCoordinates } from './core/WorldCoordinates'
import {
  EMPTY_METRICS,
  type AABB,
  type TerrainMetrics,
  type Vec3Like,
} from './core/types'
import {
  DEFAULT_TERRAIN_CONFIG,
  type TerrainConfig,
} from './config'
import { BenchmarkHistory } from './benchmarks/BenchmarkHistory'
import { evaluateHeight } from './compiler/compileSection'
import { TerrainCompiler } from './compiler/TerrainCompiler'
import type { EditorSnapshot, TerrainOverlay } from './editor/EditorStore'
import { constrainNeighborLods, selectLod } from './lod/LodSelector'
import { ModifierStack } from './modifiers/ModifierStack'
import {
  appendBrushPoint,
  createBrushStroke,
  createRemeshModifier,
  createTunnelModifier,
} from './modifiers/factories'
import type { BrushStrokeModifier } from './modifiers/types'
import { MeshPartition, type TerrainSection } from './partition/MeshPartition'
import { IndexedDbTerrainStorage, type TerrainStorage } from './persistence/TerrainStorage'
import type { TerrainRenderBackend } from './rendering/TerrainRenderBackend'
import { TerrainStreamer, type StreamCandidate } from './streaming/TerrainStreamer'

export interface TerrainUpdateInput {
  camera: Vec3Like
  viewportHeight: number
  verticalFovRadians: number
  frameMs: number
  now?: number
}

export type BenchmarkScenario = 'sculpt-torture' | 'rebuild-torture'

interface ActiveBenchmark {
  name: BenchmarkScenario
  startedAt: number
  endsAt: number
  lastStepAt: number
  step: number
}

export class WorldTerrain {
  readonly config: TerrainConfig
  readonly partition: MeshPartition
  readonly modifiers = new ModifierStack()
  readonly metrics = new ExternalStore<TerrainMetrics>(EMPTY_METRICS)
  readonly coordinates: WorldCoordinates
  private readonly compiler: TerrainCompiler
  private readonly scheduler: FrameBudgetScheduler
  private readonly streamer: TerrainStreamer
  private readonly storage: TerrainStorage
  private readonly benchmarkHistory = new BenchmarkHistory()
  private renderer?: TerrainRenderBackend
  private activeStroke?: BrushStrokeModifier
  private lastStrokePoint?: Vec3Like
  private editFocus?: Vec3Like
  private initialized = false
  private initializePromise?: Promise<void>
  private disposed = false
  private overlay: TerrainOverlay = 'sections'
  private nextSaveAt = Infinity
  private savedModifierRevision = 0
  private saveInFlight = false
  private lastMetricsAt = 0
  private schedulingMs = 0
  private activeBenchmark?: ActiveBenchmark
  private latestCamera: Vec3Like = { x: 0, y: 0, z: 0 }

  constructor(
    config: Partial<TerrainConfig> = {},
    storage: TerrainStorage = new IndexedDbTerrainStorage(),
  ) {
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config }
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
      const section = this.partition.get(result.key)
      if (!section) return
      if (result.compiled) {
        if (this.partition.acceptCompiled(section, result.compiled)) {
          this.benchmarkHistory.record('compile', result.compiled.metadata.compileMs)
        } else if (section.buildingRevision === result.revision) {
          section.buildState = 'queued'
        }
      } else if (section.revision === result.revision) {
        section.buildState = 'failed'
        section.error = result.error ?? 'Terrain compilation failed'
        section.buildJobId = undefined
        section.buildingRevision = undefined
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
    renderer.setOverlay(this.overlay)
  }

  detachRenderer(renderer: TerrainRenderBackend): void {
    if (this.renderer === renderer) this.renderer = undefined
  }

  update(input: TerrainUpdateInput): void {
    if (this.disposed) return
    const now = input.now ?? performance.now()
    this.latestCamera = { ...input.camera }
    this.scheduler.beginFrame(input.frameMs)
    const scheduleStart = performance.now()
    this.updateBenchmark(now)

    const budget = this.scheduler.snapshot()
    const candidates = this.streamer.update(
      input.camera,
      budget.qualityScale,
      this.editFocus,
      now,
    )
    const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]))

    if (this.renderer) {
      for (const section of this.partition.values()) {
        if (this.renderer.has(section.id)) this.renderer.setVisible(section.id, false)
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
          this.renderer?.has(section.id) ? section.compiled?.cpuBytes ?? 0 : 0,
          now,
        )
      }
      section.lastTouched = now
      this.maybeQueueBuild(section, candidate, now)
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
    this.updateMetrics(input.frameMs, now, candidateMap)
  }

  beginStroke(point: Vec3Like, editor: EditorSnapshot): void {
    this.editFocus = { ...point }
    if (editor.tool === 'select') return
    if (editor.tool === 'tunnel') {
      const modifier = createTunnelModifier({ center: point })
      this.modifiers.add(modifier)
      this.invalidate(modifier.bounds)
      this.markPersistenceDirty()
      return
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
      return
    }
    const stroke = createBrushStroke({
      point,
      mode: editor.tool,
      radius: editor.brushRadius,
      strength: editor.brushStrength,
      falloff: editor.brushFalloff,
      targetY: editor.tool === 'flatten' ? point.y : undefined,
    })
    this.modifiers.add(stroke)
    this.activeStroke = stroke
    this.lastStrokePoint = { ...point }
    this.invalidate(stroke.bounds)
    this.schedulePreview(stroke, point)
    this.markPersistenceDirty()
  }

  continueStroke(point: Vec3Like): void {
    const stroke = this.activeStroke
    if (!stroke || !this.lastStrokePoint) return
    const spacing = Math.max(0.75, stroke.radius * 0.14)
    if (
      Math.hypot(
        point.x - this.lastStrokePoint.x,
        point.y - this.lastStrokePoint.y,
        point.z - this.lastStrokePoint.z,
      ) < spacing
    ) {
      return
    }
    const dirtyBounds = appendBrushPoint(stroke, point)
    this.modifiers.touch()
    this.lastStrokePoint = { ...point }
    this.editFocus = { ...point }
    this.invalidate(dirtyBounds)
    this.schedulePreview(stroke, point)
    this.markPersistenceDirty()
  }

  endStroke(): void {
    this.activeStroke = undefined
    this.lastStrokePoint = undefined
  }

  setOverlay(overlay: TerrainOverlay): void {
    this.overlay = overlay
    this.renderer?.setOverlay(overlay)
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
    await this.storage.save('default', this.modifiers.snapshot())
    this.savedModifierRevision = this.modifiers.sourceRevision
    this.nextSaveAt = Infinity
  }

  async resetEdits(): Promise<void> {
    await this.storage.clear('default')
    this.modifiers.clear()
    this.installDemoModifiers()
    const now = performance.now()
    for (const section of this.partition.values()) {
      this.partition.markDirty(section, section.bounds, now)
    }
    this.savedModifierRevision = this.modifiers.sourceRevision
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
      const saved = await this.storage.load('default')
      if (saved && saved.length > 0) this.modifiers.replace(saved)
      else this.installDemoModifiers()
      this.savedModifierRevision = this.modifiers.sourceRevision
    } finally {
      this.initialized = true
    }
  }

  private installDemoModifiers(): void {
    const x = 14
    const z = 34
    const y = evaluateHeight(x, z, this.config.seed, [])
    this.modifiers.add(
      createTunnelModifier({
        center: { x, y, z },
        radius: 9,
        length: 76,
        direction: { x: 1, z: 0.16 },
      }),
    )
    this.modifiers.add(
      createRemeshModifier({
        center: { x: -52, y: evaluateHeight(-52, -12, this.config.seed, []), z: -12 },
        radius: 34,
        targetEdgeLength: 2.4,
      }),
    )
  }

  private invalidate(bounds: AABB): void {
    this.partition.invalidateBounds(bounds, this.config.operationHalo)
  }

  private maybeQueueBuild(
    section: TerrainSection,
    candidate: StreamCandidate,
    now: number,
  ): void {
    const needsBuild =
      section.buildState === 'queued' ||
      section.buildState === 'failed' ||
      (section.buildState === 'building' && section.buildingRevision !== section.revision)
    if (!needsBuild || section.buildingRevision === section.revision) return
    const coalesceDelay = section.compiled ? 95 : 0
    if (now - section.dirtySince < coalesceDelay) return
    const modifiers = this.modifiers.query(
      expandBounds(section.bounds, this.config.operationHalo),
    )
    const jobId = this.compiler.queue(
      section.key,
      section.revision,
      candidate.priority,
      modifiers,
    )
    this.partition.markBuilding(section, jobId)
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
      uploadBytes: pending.cpuBytes,
      swaps: 1,
      run: () => {
        const compiled = this.partition.commitPending(section)
        if (!compiled || !this.renderer) return
        this.renderer.upload(section, compiled)
        section.residency = candidate.visible ? 'VISIBLE' : 'GPU_RESIDENT'
        this.streamer.setState(
          section.key,
          section.residency,
          compiled.cpuBytes,
          compiled.cpuBytes,
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
      const lod = selectLod({
        lods: section.compiled.lods,
        distance,
        viewportHeight: input.viewportHeight,
        verticalFovRadians: input.verticalFovRadians,
        errorTolerancePixels:
          this.config.baseLodErrorPixels / Math.max(0.48, this.scheduler.snapshot().qualityScale),
        currentLod: section.activeLod,
      })
      section.requestedLod = lod
      nodes.push({ id: section.id, x: section.key.x, z: section.key.z, lod })
      this.renderer.setVisible(section.id, candidate.visible)
      section.residency = candidate.visible ? 'VISIBLE' : 'GPU_RESIDENT'
      this.streamer.setState(
        section.key,
        section.residency,
        section.compiled.cpuBytes,
        section.compiled.cpuBytes,
      )
    }
    const constrained = constrainNeighborLods(nodes)
    for (const [id, lod] of constrained) this.renderer.setLod(id, lod)
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
          this.compiler.cancel(key)
          this.renderer?.evict(id)
          this.partition.remove(key)
          this.streamer.evicted(id)
        },
      })
    }
  }

  private schedulePreview(stroke: BrushStrokeModifier, point: Vec3Like): void {
    this.scheduler.enqueue({
      id: `preview:${stroke.id}`,
      kind: 'maintenance',
      priority: 40_000,
      estimatedCpuMs: 0.35,
      run: () =>
        this.renderer?.previewBrush({
          mode: stroke.mode,
          point,
          radius: stroke.radius,
          strength: stroke.strength,
          falloff: stroke.falloff,
          targetY: stroke.targetY,
        }),
    })
  }

  private markPersistenceDirty(): void {
    this.nextSaveAt = performance.now() + 1_500
  }

  private scheduleAutosave(now: number): void {
    if (
      this.saveInFlight ||
      now < this.nextSaveAt ||
      this.savedModifierRevision === this.modifiers.sourceRevision
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
        const revision = this.modifiers.sourceRevision
        void this.storage
          .save('default', this.modifiers.snapshot())
          .then(() => {
            this.savedModifierRevision = revision
            this.nextSaveAt = Infinity
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
      mode: benchmark.step % 4 === 0 ? 'lower' : 'raise',
      radius: benchmark.name === 'rebuild-torture' ? 26 : 17,
      strength: 0.22,
      falloff: 0.58,
    })
    this.modifiers.add(stroke)
    this.invalidate(stroke.bounds)
    this.schedulePreview(stroke, point)
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
      if (section.buildState === 'building' || section.buildState === 'queued') rebuilding += 1
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
      cpuBytes: streaming.cpuBytes,
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
}
