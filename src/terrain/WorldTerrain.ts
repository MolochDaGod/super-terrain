import {
  clamp,
  cloneBounds,
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
  type SectionId,
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
import { WATER_LEVEL } from './compiler/climate'
import {
  sampleHeightFieldCached,
  setWorldProfile,
} from './compiler/heightField'
import { createOutcropFieldModifiers } from './demo/createOutcropField'
import { WaterStore } from './water/WaterStore'
import { TerrainCompiler } from './compiler/TerrainCompiler'
import {
  mergeCompiledLevels,
  missingCompiledLevels,
  retainCompiledLevels,
} from './compiler/CompiledSectionArtifacts'
import { repaintCompiledSection } from './compiler/PaintWeights'
import {
  createShowcaseTerrainModifiers,
  upgradeShowcaseTerrainModifiers,
} from './demo/createShowcaseModifiers'
import type { EditorSnapshot, TerrainOverlay } from './editor/EditorStore'
import {
  cameraSectionDistance,
  constrainNeighborLods,
  type LodNeighborNode,
  detailFocusLodCeiling,
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
  BooleanVolumeModifier,
  BrushStrokeModifier,
  CsgOperation,
  MaterialSettingsModifier,
  ModifierTransform,
  SculptLayerModifier,
  WeightPaintModifier,
} from './modifiers/types'
import {
  distanceToCutterVolume,
  type CapsuleCutter,
} from './modifiers/boolean/CutterVolume'
import { tunnelCutterVolumes } from './modifiers/boolean/MeshBooleanBackend'
import { sampleStrokeSegment } from './modifiers/strokeSampling'
import {
  tunnelPortalDistance,
  updateTunnelPortal,
} from './modifiers/tunnel'
import {
  modifierWorldBounds,
  materializeModifierTransforms,
  normalizedTransform,
  transformedBooleanVolume,
  transformedTunnel,
} from './modifiers/transform'
import { MeshPartition, type TerrainSection } from './partition/MeshPartition'
import { CompiledSectionCacheSignatures } from './persistence/CompiledSectionCache'
import {
  IndexedDbTerrainStorage,
  type CompiledSectionCacheRecord,
  type TerrainStorage,
} from './persistence/TerrainStorage'
import {
  loadShowcaseSectionBake,
  SHOWCASE_BAKED_SECTION_IDS,
} from './prebake/showcaseSectionBake'
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
  randomGraniteRockParameters,
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

/**
 * Deposition while the pointer is held still, in accumulated brush weight per
 * second. One unit is roughly what a single unhurried pass lays down, so a held
 * brush reaches full depth in a little under a second.
 */
const BRUSH_FLOW_PER_SECOND = 1.5
/** Ceiling on a single authored dab, so no one frame steps the surface. */
const MAX_AUTHORED_DAB_WEIGHT = 0.25
/** Dab spacing along a stroke, as a fraction of brush radius. */
const BRUSH_SPACING_FRACTION = 0.1

/**
 * Dab spacing for a brush, in metres.
 *
 * Spacing and per-dab weight are derived from each other, so how much material
 * a pass deposits depends on the brush and the strength the user set and not on
 * how fast they happened to drag the pointer.
 */
function strokeSpacing(radius: number): number {
  return Math.max(0.25, radius * BRUSH_SPACING_FRACTION)
}

function spatialDabWeight(radius: number): number {
  return strokeSpacing(radius) / Math.max(0.001, radius)
}
const GRANITE_PLANT_DEPTH_RATIO = 0.06
/**
 * How far a section's compiled detail may exceed what its distance now asks
 * for before the detail is given back.
 *
 * One level, because there are only five. At two, a section holding the middle
 * level while its distance asked for the coarsest failed the test exactly --
 * `4 > 2 + 2` is false -- so the levels in the middle of the range, which are
 * most of them, were never reclaimed at all: a ground-level traverse of the map
 * left 120 MB resident against 70 MB at rest. This is still strictly more
 * cautious than the refining direction, which rebuilds on any improvement at
 * all, so a camera sitting on a level boundary cannot oscillate through it.
 */
const LOD_RECLAIM_SLACK = 1

/**
 * How long a section may actively compile before the job is written off.
 *
 * A lost job is not a stall the streamer can see: `hasPendingTerrainWork` stays
 * true forever, the static-scene fast path can never re-engage, and the whole
 * per-frame streaming and LOD pass runs for the rest of the session. The
 * Queue time and requests buffered behind another message in a worker do not
 * count. Exact showcase CSG currently measures about 5.6 seconds at the finest
 * level, leaving a wide margin before genuine recovery begins.
 */
const STUCK_BUILD_MS = 20_000
const STUCK_BUILD_SWEEP_MS = 2_000

/**
 * How far the camera may drift before screen-space LOD is re-derived.
 *
 * Well below the distance that can move any section across a level boundary --
 * the finest transition in the shipped world is tens of metres wide -- so this
 * only ever suppresses recomputation that would have produced the same answer.
 */
const LOD_SELECTION_EPSILON_METRES = 0.75
/** Fraction of its own distance a section may drift before it is re-selected. */
const LOD_SELECTION_DISTANCE_BAND = 0.06

/**
 * How many sections are given a full build decision per frame.
 *
 * The candidate list is priority-ordered, so the first slice is what the camera
 * is pointed at and gets decided every frame; the rest is walked by a cursor
 * that covers a thousand-section world in about four frames. Both numbers exist
 * because the alternative -- deciding for everything, every frame -- was tens
 * of milliseconds of the frame while the camera moved, spent almost entirely on
 * sections whose answer had not changed.
 */
const HOT_CANDIDATES_PER_FRAME = 128
const COLD_CANDIDATES_PER_FRAME = 192

/** First level compiled for a section that has nothing to show yet. */
const COLD_START_LOD_FLOOR = 2
const MOVING_CAMERA_METRES_PER_SECOND = 35
const FAST_CAMERA_METRES_PER_SECOND = 90

function compiledGpuBytes(compiled: CompiledSection | undefined): number {
  return compiled?.gpuBytes ?? compiled?.lods.reduce(
    (bytes, lod) => bytes + lod.gpuBytes,
    0,
  ) ?? 0
}

function finestCompiledLod(compiled: CompiledSection): number {
  return compiled.lods.reduce(
    (finest, lod) => Math.min(finest, lod.level),
    Infinity,
  )
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
type DigTargetModifier = BooleanSubtractModifier | BooleanVolumeModifier

export interface CameraDigRay {
  direction: Vec3Like
}

interface ActiveDig {
  modifier: DigTargetModifier
  capsule: CapsuleCutter
  entry: Vec3Like
  direction: Vec3Like
  radius: number
  speed: number
  length: number
  originalBounds: AABB
  paused: boolean
  previewElapsed: number
  noise: number
  noiseScale: number
}

interface PendingCompiledCacheWrite {
  section: TerrainSection
  compiled: CompiledSection
  revision: number
  generation: number
  finestLod: number
}

export class WorldTerrain {
  readonly config: TerrainConfig
  readonly partition: MeshPartition
  readonly modifiers: ModifierStack
  readonly rocks = new GraniteRockStore()
  readonly water: WaterStore
  readonly metrics = new ExternalStore<TerrainMetrics>(EMPTY_METRICS)
  private lastCompileError: string | null = null
  readonly coordinates: WorldCoordinates
  private readonly compiler: TerrainCompiler
  private readonly scheduler: FrameBudgetScheduler
  private readonly streamer: TerrainStreamer
  private readonly storage: TerrainStorage
  private readonly benchmarkHistory = new BenchmarkHistory()
  private renderer?: TerrainRenderBackend
  private activeStroke?: ActiveStrokeModifier
  private activeTunnel?: BooleanSubtractModifier
  private activeDig?: ActiveDig
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
  private cachedCandidateMap: ReadonlyMap<SectionId, StreamCandidate> = new Map()
  /** Rotating position in the low-priority tail of the candidate list. */
  private serviceCursor = 0
  /** Sections holding a finished compile that has not been presented yet. */
  private readySwaps = new Set<SectionId>()
  private terrainStateRevision = 0
  private processedTerrainStateRevision = -1
  private hasPendingTerrainWork = true
  private lastIdleMaintenanceAt = 0
  private lastStuckSweepAt = 0
  /** Screen-space level chosen per section, before the neighbour constraint. */
  private selectedLod = new Map<SectionId, number>()
  /** Result of the last neighbour-constraint pass, reused while the view holds. */
  private constrainedLod = new Map<SectionId, number>()
  /** Level last handed to the renderer, so unchanged sections enqueue nothing. */
  private requestedRendererLod = new Map<SectionId, number>()
  /** Distance to each section when its level was last chosen. */
  private lodSelectionDistance = new Map<SectionId, number>()
  /** Reused between frames: the constraint input is rebuilt on every one. */
  private lodNodes: LodNeighborNode[] = []
  private lodNodeRecords = new Map<SectionId, LodNeighborNode>()
  private lodSelectionQuality = Number.NaN
  private lodSelectionViewportHeight = Number.NaN
  private lodSelectionFov = Number.NaN
  private readonly compiledCacheSignatures = new CompiledSectionCacheSignatures()
  private persistedCompiledSectionIds = new Set<SectionId>()
  private cacheLookupEligibleIds = new Set<SectionId>()
  private pendingCacheLookups = new Set<SectionId>()
  private cacheLookupsInFlight = new Set<SectionId>()
  private cacheLookupScheduled = false
  private compiledCacheLookupBatches = 0
  private pendingCompiledCacheWrites = new Map<
    SectionId,
    PendingCompiledCacheWrite
  >()
  private bestCompiledCacheWrites = new Map<
    SectionId,
    { revision: number; finestLod: number }
  >()
  private compiledCacheWriteTimer?: ReturnType<typeof setTimeout>
  private compiledCacheWritePromise?: Promise<void>
  private compiledCacheWritesDisabled = false
  private compiledCacheGeneration = 0
  private warnedAboutCompiledCache = false
  private warmCacheStartup = false
  private readonly heightColumn: AABB = {
    min: { x: 0, y: -Infinity, z: 0 },
    max: { x: 0, y: Infinity, z: 0 },
  }

  constructor(
    config: Partial<TerrainConfig> = {},
    storage: TerrainStorage = new IndexedDbTerrainStorage(),
  ) {
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config }
    this.modifiers = new ModifierStack(this.config.sectionSize)
    // The main thread samples the same height field the workers do — for rock
    // planting, water and `sampleHeight` — so it needs the profile too.
    setWorldProfile(this.config.worldProfile)
    this.water = new WaterStore(this.config.worldSize)
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
        const buildingLod = section.buildingRevision === result.revision
          ? section.buildingLod
          : undefined
        const retainedLevels = buildingLod === undefined
          ? undefined
          : requestedLevels(buildingLod, this.config.lodResolutions.length)
        const compiled = mergeCompiledLevels(
          section.compiled?.sourceRevision === result.revision
            ? section.compiled
            : undefined,
          result.compiled,
          retainedLevels,
        )
        if (this.partition.acceptCompiled(section, compiled)) {
          this.readySwaps.add(section.id)
          this.benchmarkHistory.record('compile', result.compiled.metadata.compileMs)
          this.queueCompiledCacheWrite(section, compiled)
        } else if (section.buildingRevision === result.revision) {
          section.buildState = 'queued'
          section.buildJobId = undefined
          section.buildingRevision = undefined
          section.buildingLod = undefined
        }
      } else if (section.revision === result.revision) {
        section.buildJobId = undefined
        section.buildingRevision = undefined
        section.buildingLod = undefined
        if (result.retryable) {
          // The pool lost the job rather than the section failing to compile.
          // Nothing is wrong with the terrain, so it goes back in the queue
          // silently instead of turning the section red.
          section.buildState = 'queued'
          section.error = undefined
          return
        }
        section.buildState = 'failed'
        section.error = result.error ?? 'Terrain compilation failed'
        // A section that cannot compile keeps whatever geometry it last had
        // until an LOD change or an eviction takes it, and then there is
        // nothing to put back -- the ground simply vanishes. That has to be
        // visible in the editor rather than only in the console.
        this.lastCompileError = `${section.id}: ${section.error}`
        console.error(
          `Terrain section ${section.id} failed to compile: ${section.error}`,
        )
      }
    }
  }

  /**
   * `discardSavedWorld` throws the persisted stack away *before* the world is
   * built, rather than resetting afterwards. Resetting after the fact races the
   * load it is trying to undo — the initial world is still streaming when every
   * section is marked dirty under it — and the observable result is a scene
   * that has meshes, sections and a camera but never presents a frame.
   */
  initialize(options: { discardSavedWorld?: boolean } = {}): Promise<void> {
    if (this.initializePromise) return this.initializePromise
    this.initializePromise = options.discardSavedWorld
      ? this.storage
          .clear('default')
          .then(() => this.loadPersistedWorld())
      : this.loadPersistedWorld()
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
    this.scheduler.beginFrame(input.frameMs, this.warmCacheStartup ? 6 : 1)
    const scheduleStart = performance.now()
    this.updateBenchmark(now)

    this.sweepStuckBuilds(now)

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
      !this.activeDig &&
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
          this.scheduleSectionBatching(now)
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
      HOT_CANDIDATES_PER_FRAME,
    )
    const candidateMap = this.streamer.candidatesById
    this.cancelDepartedBuilds(this.streamer.departed)
    this.cachedCandidateMap = candidateMap

    // Only what actually stopped being visible is hidden. The old sweep asked
    // the same question of every section in the world on every frame.
    if (this.renderer) {
      for (const id of this.streamer.hidden) {
        if (this.renderer.has(id)) this.renderer.setVisible(id, false)
      }
    }

    this.serviceCandidates(candidates, input, now)
    this.scheduleReadySwaps(candidateMap)

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
      this.scheduleSectionBatching(now)
    }

    this.schedulingMs = performance.now() - scheduleStart
    this.scheduler.runFrame()
    this.horizonProxyMask.update(
      candidateMap.values(),
      (id) => this.renderer?.has(id) === true,
    )
    this.processedTerrainStateRevision = this.terrainStateRevision
    this.hasPendingTerrainWork = this.detectPendingTerrainWork()
    if (
      this.warmCacheStartup &&
      !this.hasPendingTerrainWork &&
      this.pendingCacheLookups.size === 0 &&
      this.cacheLookupsInFlight.size === 0
    ) {
      this.warmCacheStartup = false
    }
    this.updateMetrics(input.frameMs, now, candidateMap)
  }

  beginStroke(
    point: Vec3Like,
    normal: Vec3Like,
    editor: EditorSnapshot,
    ray?: CameraDigRay,
  ): string | undefined {
    // A physical press owns exactly one brush-stroke modifier. Treat duplicate
    // pointer-down delivery as re-entry into the existing authoring session.
    if (this.activeStroke) return this.activeStroke.id
    if (this.activeTunnel) return this.activeTunnel.id
    if (this.activeDig) return this.activeDig.modifier.id
    this.editFocus = { ...point }
    // Tools that do not deform the terrain never open a stroke. Water paints
    // its own coverage field, and the viewport verbs only move the camera, the
    // selection or the 3D cursor.
    if (
      editor.tool === 'select' ||
      editor.tool === 'camera' ||
      editor.tool === 'cursor' ||
      editor.tool === 'water' ||
      // Drawing a forest spline never touches the terrain. It reaches here at
      // all only if a pointer path is added that does not know that; a stroke
      // opened for it would deform the ground under the spline being drawn.
      editor.tool === 'forest'
    ) {
      return
    }
    if (editor.tool === 'tunnel') {
      const portal = { ...point, normal: { ...normal } }
      const modifier = createTunnelModifier({
        start: portal,
        end: portal,
        radius: editor.tunnelRadius,
        depth: editor.tunnelDepth,
        noise: editor.tunnelNoise,
        noiseScale: editor.tunnelNoiseScale,
      })
      this.modifiers.add(modifier)
      this.activeTunnel = modifier
      return modifier.id
    }
    if (editor.tool === 'dig') {
      return this.beginDigStroke(point, normal, editor, ray)
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
          sampleWeight: spatialDabWeight(editor.brushRadius),
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
          accumulate: editor.brushAccumulate,
          sculptLayerId,
          sampleWeight: spatialDabWeight(editor.brushRadius),
        })
    this.modifiers.add(stroke)
    this.activeStroke = stroke
    this.lastStrokePoint = { ...point }
    this.lastStrokeNormal = { ...strokeNormal }
    this.liveStrokePoint = { ...point }
    this.liveStrokeNormal = { ...strokeNormal }
    this.forceEditingLod(point, stroke.radius)
    this.renderer?.beginBrushPreview()
    this.applyPreview(stroke, [stroke.points[0]])
    return stroke.id
  }

  continueStroke(
    point: Vec3Like,
    normal: Vec3Like,
    ray?: CameraDigRay,
  ): void {
    if (this.activeTunnel) {
      updateTunnelPortal(this.activeTunnel, 1, point, normal)
      this.editFocus = { ...point }
      this.modifiers.touch()
      return
    }
    if (this.activeDig) {
      this.continueDigStroke(point, normal, ray)
      return
    }
    const stroke = this.activeStroke
    if (!stroke || !this.lastStrokePoint || !this.lastStrokeNormal) return
    const spacing = strokeSpacing(stroke.radius)
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
      spatialDabWeight(stroke.radius),
    )
    if (samples.length === 0) return
    for (const sample of samples) {
      appendBrushPoint(stroke, sample, sample.normal, sample.weight)
    }
    if (stroke.type === 'brush-stroke') this.modifiers.touch()
    const latest = samples.at(-1)!
    this.lastStrokePoint = { x: latest.x, y: latest.y, z: latest.z }
    this.lastStrokeNormal = { ...latest.normal }
    // No authoritative rebuild mid-stroke. Every dab used to invalidate, so a
    // drag queued a section recompile per pointer event and the viewport spent
    // the stroke swapping between half-finished results. The preview already
    // shows the exact same kernel the worker will run, so the rebuild is worth
    // exactly one compile and it happens when the gesture ends.
    this.applyPreview(stroke, samples)
  }

  endStroke(): StrokeEndResult {
    if (this.activeDig) {
      const dig = this.activeDig
      this.activeDig = undefined
      dig.modifier.bounds = modifierWorldBounds(dig.modifier)
      this.modifiers.touch()
      this.invalidate(unionBounds(dig.originalBounds, dig.modifier.bounds))
      this.markPersistenceDirty()
      return 'committed'
    }
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
    const completedStroke = this.activeStroke
    const hadStroke = Boolean(completedStroke)
    if (completedStroke) {
      this.modifiers.touch()
      if (completedStroke.type === 'brush-stroke') {
        this.invalidate(completedStroke.bounds)
      }
      if (completedStroke.type === 'weight-paint') {
        // Painting already mutated the resident GPU attributes directly. Only
        // now advance the authoritative revisions. Provenance lets current
        // compiled geometry receive the exact final weights immediately; old
        // caches and mixed hierarchies repaint their retained streams directly.
        const invalidated = this.invalidate(completedStroke.bounds)
        this.applyIncrementalPaintArtifacts(invalidated)
      }
      this.markPersistenceDirty()
    }
    if (hadStroke) this.renderer?.endBrushPreview()
    this.activeStroke = undefined
    this.lastStrokePoint = undefined
    this.lastStrokeNormal = undefined
    this.liveStrokePoint = undefined
    this.liveStrokeNormal = undefined
    return hadStroke ? 'committed' : 'none'
  }

  pauseActiveStroke(): void {
    if (this.activeDig) this.activeDig.paused = true
    this.liveStrokePoint = undefined
    this.liveStrokeNormal = undefined
  }

  advanceActiveStroke(deltaSeconds: number): void {
    if (this.activeDig) {
      this.advanceDigStroke(deltaSeconds)
      return
    }
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

  private beginDigStroke(
    point: Vec3Like,
    normal: Vec3Like,
    editor: EditorSnapshot,
    ray?: CameraDigRay,
  ): string {
    const radius = Math.max(0.5, editor.digRadius)
    const direction = digDirection(ray, normal)
    const length = Math.max(0.75, radius * 0.7)
    const initialCapsule = createDigCapsule(
      point,
      direction,
      radius,
      length,
      editor.digNoise,
      editor.digNoiseScale,
    )
    const existing = this.findDigTarget(point, radius)
    let modifier: DigTargetModifier
    let capsule: CapsuleCutter
    let originalBounds: AABB

    if (existing) {
      originalBounds = cloneBounds(existing.bounds)
      this.materializeDigTarget(existing)
      capsule = initialCapsule
      appendDigCapsule(existing, capsule)
      existing.bounds = modifierWorldBounds(existing)
      modifier = existing
      this.modifiers.touch()
    } else {
      const created = createBooleanVolumeModifier({
        operation: 'subtract',
        volumes: [initialCapsule],
      })
      created.backend = 'bvh-csg-cave-dig-v1'
      modifier = this.modifiers.add(created)
      capsule = modifier.volumes[0] as CapsuleCutter
      originalBounds = cloneBounds(modifier.bounds)
    }

    this.activeDig = {
      modifier,
      capsule,
      entry: { ...point },
      direction,
      radius,
      speed: Math.max(0.5, editor.digSpeed),
      length,
      originalBounds,
      paused: false,
      previewElapsed: 0,
      noise: Math.max(0, editor.digNoise),
      noiseScale: Math.max(0.25, editor.digNoiseScale),
    }
    this.editFocus = { ...point }
    this.forceEditingLod(point, radius)
    return modifier.id
  }

  private continueDigStroke(
    point: Vec3Like,
    normal: Vec3Like,
    ray?: CameraDigRay,
  ): void {
    const dig = this.activeDig
    if (!dig) return
    const direction = digDirection(ray, normal)
    const moved = distance3(point, dig.entry)
    const aimDot = dot3(direction, dig.direction)
    if (moved >= Math.max(0.5, dig.radius * 0.4) || aimDot < 0.94) {
      dig.entry = { ...point }
      dig.direction = direction
      dig.length = Math.max(0.75, dig.radius * 0.7)
      dig.capsule = createDigCapsule(
        dig.entry,
        dig.direction,
        dig.radius,
        dig.length,
        dig.noise,
        dig.noiseScale,
      )
      appendDigCapsule(dig.modifier, dig.capsule)
      dig.modifier.bounds = modifierWorldBounds(dig.modifier)
      this.modifiers.touch()
    }
    dig.paused = false
    this.editFocus = { ...point }
    this.forceEditingLod(point, dig.radius)
  }

  private advanceDigStroke(deltaSeconds: number): void {
    const dig = this.activeDig
    if (!dig || dig.paused) return
    const elapsed = Math.min(0.05, Math.max(0, deltaSeconds))
    if (elapsed <= 0) return
    dig.length += dig.speed * elapsed
    dig.capsule.end = addScaled(dig.entry, dig.direction, dig.length)
    dig.modifier.bounds = modifierWorldBounds(dig.modifier)
    this.editFocus = { ...dig.capsule.end }
    this.forceEditingLod(dig.capsule.end, dig.radius)

    // Refresh the lightweight wireframe often enough to make held drilling
    // legible without rebuilding preview geometry on every animation frame.
    dig.previewElapsed += elapsed
    if (dig.previewElapsed >= 0.15) {
      dig.previewElapsed = 0
      this.modifiers.touch()
    }
  }

  private findDigTarget(
    point: Vec3Like,
    radius: number,
  ): DigTargetModifier | undefined {
    let nearest: { id: string; distance: number } | undefined
    for (const modifier of this.modifiers.snapshot()) {
      if (!modifier.enabled) continue
      let cutters
      if (modifier.type === 'boolean-subtract') {
        cutters = tunnelCutterVolumes(modifier)
      } else if (
        modifier.type === 'boolean-volume' &&
        modifier.operation === 'subtract'
      ) {
        cutters = transformedBooleanVolume(modifier).volumes
      } else {
        continue
      }
      let distance = Infinity
      for (const cutter of cutters) {
        distance = Math.min(distance, distanceToCutterVolume(point, cutter))
      }
      if (distance <= radius && (!nearest || distance < nearest.distance)) {
        nearest = { id: modifier.id, distance }
      }
    }
    const target = nearest ? this.modifiers.get(nearest.id) : undefined
    return target?.type === 'boolean-subtract' ||
      (target?.type === 'boolean-volume' && target.operation === 'subtract')
      ? target
      : undefined
  }

  private materializeDigTarget(modifier: DigTargetModifier): void {
    if (modifier.type === 'boolean-subtract') {
      const materialized = transformedTunnel(modifier)
      modifier.portals = materialized.portals
      modifier.radius = materialized.radius
      modifier.depth = materialized.depth
      modifier.noise = materialized.noise
      modifier.noiseScale = materialized.noiseScale
      modifier.carves = materialized.carves ?? []
      modifier.transform = normalizedTransform()
      modifier.bounds = materialized.bounds
      return
    }
    const materialized = transformedBooleanVolume(modifier)
    modifier.volumes = materialized.volumes
    modifier.transform = normalizedTransform()
    modifier.bounds = materialized.bounds
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
    values: Partial<
      Pick<BooleanSubtractModifier, 'radius' | 'depth' | 'noise' | 'noiseScale'>
    >,
  ): boolean {
    const modifier = this.modifiers.get(id)
    if (!modifier || modifier.type !== 'boolean-subtract') return false
    const previousBounds = modifier.bounds
    if (values.radius !== undefined) modifier.radius = Math.max(0.25, values.radius)
    if (values.depth !== undefined) modifier.depth = Math.max(0.25, values.depth)
    if (values.noise !== undefined) modifier.noise = Math.max(0, values.noise)
    if (values.noiseScale !== undefined) {
      modifier.noiseScale = Math.max(0.25, values.noiseScale)
    }
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
    await this.flushCompiledCacheWrites()
    this.persistWater()
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
    this.resetCompiledCacheState()
    await this.storage.clear('default')
    this.modifiers.clear()
    this.rocks.clear()
    this.water.clear()
    if (this.config.worldContent.water) this.water.seedFromRiver(this.config.seed)
    this.installDemoModifiers()
    this.installProceduralRocks(this.config.worldContent.rocks)
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
    // Deliberately not `snapshot()`. This is called per pointer move by the
    // cursor, per planted rock and per frame by anything following the ground,
    // and a snapshot deep-clones every modifier in the document -- including
    // re-deriving mesh-cutter world bounds, which walks their vertices. The
    // column query hands back the same live modifiers the compiler reads, and
    // only the ones whose bounds actually cover this point.
    const column = this.heightColumn
    column.min.x = x - 0.001
    column.max.x = x + 0.001
    column.min.z = z - 0.001
    column.max.z = z + 0.001
    return evaluateHeight(x, z, this.config.seed, this.modifiers.query(column))
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
    if (this.compiledCacheWriteTimer !== undefined) {
      clearTimeout(this.compiledCacheWriteTimer)
      this.compiledCacheWriteTimer = undefined
    }
    void this.flushCompiledCacheWrites()
    this.disposed = true
    this.compiler.dispose()
    this.scheduler.clear()
  }

  private async loadPersistedWorld(): Promise<void> {
    try {
      const [saved, savedRocks, cachedSectionIds] = await Promise.all([
        this.storage.load('default'),
        this.storage.loadRocks?.('default') ?? Promise.resolve(undefined),
        this.loadCompiledCacheIndex(),
      ])
      this.persistedCompiledSectionIds = new Set(cachedSectionIds)
      this.cacheLookupEligibleIds = new Set(cachedSectionIds)
      this.warmCacheStartup = cachedSectionIds.length > 0
      // The legacy migration imports the old mesh-CSG showcase only for an
      // existing document that can actually need it. A fresh scene no longer
      // generates dozens of granite operands merely by importing WorldTerrain.
      const showcaseUpgrade = saved?.length
        ? upgradeShowcaseTerrainModifiers(saved, this.config.seed)
        : undefined
      const upgraded = showcaseUpgrade ?? (saved?.length
        ? (await import('./demo/createDemoModifiers'))
            .upgradeLegacyDemoTerrainModifiers(saved, this.config.seed)
        : undefined)
      let installedFreshShowcase = false
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
        installedFreshShowcase = true
      }
      this.rocks.replace(savedRocks ?? [])
      this.restoreWater()
      this.ensureDocumentModifiers()
      if (installedFreshShowcase) {
        this.installProceduralRocks(this.config.worldContent.rocks)
      }
      if (
        installedFreshShowcase &&
        this.config.worldContent.showcase &&
        !SHOWCASE_BAKED_SECTION_IDS.every((id) =>
          this.persistedCompiledSectionIds.has(id),
        )
      ) {
        await this.installShowcaseSectionBake()
      }
      this.renderer?.setMaterialSettings(this.getMaterialSettings())
      // A fresh showcase used to remain an ephemeral default forever, forcing
      // every reload to regenerate its large operand document before terrain
      // streaming could even start. Persist it once, after the cold launch has
      // had time to present useful pixels.
      this.savedModifierRevision = installedFreshShowcase
        ? -1
        : this.modifiers.sourceRevision
      this.savedRockRevision = this.rocks.sourceRevision
      if (installedFreshShowcase) {
        this.nextSaveAt = performance.now() + 8_000
      }
    } finally {
      this.initialized = true
    }
  }

  /** Local-storage key. Scoped to the world, so a new world starts dry. */
  private get waterStorageKey(): string {
    return `meshterrain.water.${this.config.worldProfile}.${this.config.seed}`
  }

  private restoreWater(): void {
    let restored = false
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(this.waterStorageKey)
        if (raw) {
          this.water.restore(JSON.parse(raw) as { coverage?: string })
          restored = true
        }
      } catch {
        restored = false
      }
    }
    if (restored) return
    if (this.config.worldContent.water) this.water.seedFromRiver(this.config.seed)
  }

  private persistWater(): void {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(this.waterStorageKey, JSON.stringify(this.water.serialize()))
    } catch {
      // Water that cannot be saved is still water that can be painted.
    }
  }

  private installDemoModifiers(): void {
    const content = this.config.worldContent
    if (content.showcase) {
      for (const modifier of createShowcaseTerrainModifiers(this.config.seed)) {
        this.modifiers.add(modifier)
      }
      return
    }
    // A generated world gets the same outcrop generator the demo uses, on its
    // own seed. There is no cheaper substitute here: the patches are genuine
    // Boolean topology, and swapping them for a noise bump would be exactly the
    // drop in quality a "new world" is not allowed to have.
    if (content.outcrops) {
      for (const modifier of createOutcropFieldModifiers(this.config.seed)) {
        this.modifiers.add(modifier)
      }
    }
  }

  /**
   * Plant the world's glacial erratics.
   *
   * Sites are drawn from the height field rather than from a list: a rock wants
   * ground that is neither underwater nor a cliff face, and that is a property
   * of the terrain the seed produced, not of the seed itself.
   */
  private installProceduralRocks(count: number): void {
    if (count <= 0) return
    const spread = Math.min(this.config.worldSize * 0.12, 460)
    // Gather candidates first and rank them, rather than accepting the first
    // sites that pass a threshold. A seed whose whole near field is a cliff
    // face would otherwise plant nothing at all and silently give the user an
    // empty world where they asked for erratics.
    const candidates: { x: number; z: number; y: number; steepness: number }[] = []
    for (let attempt = 0; attempt < count * 30; attempt += 1) {
      const angle = hashUnit(attempt, 17, this.config.seed) * Math.PI * 2
      const radius = 40 + Math.sqrt(hashUnit(attempt, 29, this.config.seed)) * spread
      const x = Math.cos(angle) * radius
      const z = Math.sin(angle) * radius
      const sample = sampleHeightFieldCached(x, z, this.config.seed)
      // Underwater is the one hard rejection: a submerged boulder is invisible.
      if (sample.height < WATER_LEVEL + 2) continue
      candidates.push({ x, z, y: sample.height, steepness: sample.steepness })
    }
    candidates.sort((first, second) => first.steepness - second.steepness)

    for (const [index, site] of candidates.slice(0, count).entries()) {
      const seed = Math.floor(hashUnit(index, 37, this.config.seed) * 4096) + 1
      this.addGraniteRock(
        {
          ...randomGraniteRockParameters(seed),
          placementScale: 4 + hashUnit(index, 41, this.config.seed) * 12,
          detail: 3,
        },
        { x: site.x, y: site.y, z: site.z },
      )
    }
  }

  private async installShowcaseSectionBake(): Promise<void> {
    const sections = await loadShowcaseSectionBake(this.config)
    for (const compiled of sections) {
      const section = this.partition.getOrCreate(compiled.key)
      // Fresh procedural cells start at revision zero. Keep the guard explicit
      // so an initialization race can never overwrite an authored source.
      if (section.revision !== 0 || !section.source.procedural) continue
      if (section.compiled || section.pendingCompiled) continue
      compiled.sourceRevision = section.revision
      if (this.partition.acceptCompiled(section, compiled)) {
        this.readySwaps.add(section.id)
        // The shipped bake is also useful to saved documents on later boots.
        // Persist it under the same exact input signature as worker results.
        this.queueCompiledCacheWrite(section, compiled)
      }
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

  private async loadCompiledCacheIndex(): Promise<SectionId[]> {
    if (!this.storage.loadCompiledSectionKeys) return []
    try {
      return await this.storage.loadCompiledSectionKeys('default')
    } catch (error) {
      this.warnCompiledCache('Compiled terrain cache index unavailable', error)
      return []
    }
  }

  private requestCompiledCacheLookup(section: TerrainSection): boolean {
    if (
      !this.storage.loadCompiledSections ||
      !section.source.procedural ||
      !this.cacheLookupEligibleIds.has(section.id)
    ) {
      return false
    }
    if (
      this.pendingCacheLookups.has(section.id) ||
      this.cacheLookupsInFlight.has(section.id)
    ) {
      return true
    }

    this.pendingCacheLookups.add(section.id)
    this.scheduleCompiledCacheLookupFlush()
    return true
  }

  private scheduleCompiledCacheLookupFlush(): void {
    if (
      this.cacheLookupScheduled ||
      this.pendingCacheLookups.size === 0 ||
      this.compiledCacheLookupBatches >= 3
    ) {
      return
    }
    this.cacheLookupScheduled = true
    queueMicrotask(() => {
      this.cacheLookupScheduled = false
      void this.flushCompiledCacheLookups()
    })
  }

  private async flushCompiledCacheLookups(): Promise<void> {
    const load = this.storage.loadCompiledSections
    if (
      !load ||
      this.pendingCacheLookups.size === 0 ||
      this.disposed ||
      this.compiledCacheLookupBatches >= 3
    ) return
    // Keep each structured-clone batch small enough that the first high-
    // priority cells can upload while IndexedDB is still reading the horizon.
    const ids = [...this.pendingCacheLookups].slice(0, 24)
    const generation = this.compiledCacheGeneration
    for (const id of ids) this.pendingCacheLookups.delete(id)
    for (const id of ids) this.cacheLookupsInFlight.add(id)
    this.compiledCacheLookupBatches += 1
    // Pipeline several small readonly transactions. This preserves fast first
    // cells without serializing five full IndexedDB round trips for the view.
    this.scheduleCompiledCacheLookupFlush()

    try {
      const records = await load.call(this.storage, 'default', ids)
      const recordsById = new Map(
        records.map((record) => [record.sectionId, record]),
      )
      await Promise.all(
        ids.map((id) =>
          this.hydrateCompiledCacheRecord(
            id,
            recordsById.get(id),
            generation,
          ),
        ),
      )
    } catch (error) {
      for (const id of ids) {
        this.cacheLookupEligibleIds.delete(id)
        this.persistedCompiledSectionIds.delete(id)
      }
      this.warnCompiledCache('Compiled terrain cache read failed', error)
    } finally {
      for (const id of ids) this.cacheLookupsInFlight.delete(id)
      this.compiledCacheLookupBatches -= 1
      this.terrainStateRevision += 1
      this.hasPendingTerrainWork = true
      this.scheduleCompiledCacheLookupFlush()
    }
  }

  private async hydrateCompiledCacheRecord(
    id: SectionId,
    record: CompiledSectionCacheRecord | undefined,
    generation: number,
  ): Promise<void> {
    if (generation !== this.compiledCacheGeneration || this.disposed) return
    const section = this.partition.get(parseSectionId(id))
    // Camera travel can retire a request while IndexedDB is reading it. Leave
    // that entry eligible so a later visit can still hydrate it.
    if (!section || !this.streamer.isDesired(section.key)) return

    if (!record) {
      this.cacheLookupEligibleIds.delete(id)
      this.persistedCompiledSectionIds.delete(id)
      return
    }

    const revision = section.revision
    const signature = await this.compiledCacheSignature(section)
    if (
      generation !== this.compiledCacheGeneration ||
      this.disposed ||
      this.partition.get(section.key) !== section ||
      section.revision !== revision
    ) {
      return
    }

    this.cacheLookupEligibleIds.delete(id)
    if (record.signature !== signature) {
      // The record remains harmless in IndexedDB, and the next accepted worker
      // result overwrites it. Removing it from the in-memory index prevents a
      // stale lookup loop in the meantime.
      this.persistedCompiledSectionIds.delete(id)
      return
    }

    record.compiled.sourceRevision = revision
    if (this.partition.acceptCompiled(section, record.compiled)) {
      this.readySwaps.add(section.id)
      this.bestCompiledCacheWrites.set(id, {
        revision,
        finestLod: finestCompiledLod(record.compiled),
      })
    }
  }

  private compiledCacheSignature(section: TerrainSection): Promise<string> {
    return this.compiledCacheSignatures.create(
      this.config,
      section.key,
      this.modifiers.query(
        expandBounds(section.bounds, this.config.operationHalo),
      ),
      this.modifiers.sourceRevision,
    )
  }

  private queueCompiledCacheWrite(
    section: TerrainSection,
    compiled: CompiledSection,
  ): void {
    if (
      !this.storage.saveCompiledSections ||
      this.compiledCacheWritesDisabled ||
      !section.source.procedural
    ) {
      return
    }
    const finestLod = finestCompiledLod(compiled)
    const previous = this.bestCompiledCacheWrites.get(section.id)
    if (
      previous &&
      (previous.revision > section.revision ||
        (previous.revision === section.revision &&
          previous.finestLod <= finestLod))
    ) {
      return
    }
    this.bestCompiledCacheWrites.set(section.id, {
      revision: section.revision,
      finestLod,
    })
    this.pendingCompiledCacheWrites.set(section.id, {
      section,
      compiled,
      revision: section.revision,
      generation: this.compiledCacheGeneration,
      finestLod,
    })
    // Debounce the cold compile wave. Fingerprinting giant authored operands
    // and asking IndexedDB to clone mesh buffers should happen after useful
    // pixels are already arriving, not in every worker-result callback.
    if (this.compiledCacheWriteTimer !== undefined) {
      clearTimeout(this.compiledCacheWriteTimer)
    }
    this.compiledCacheWriteTimer = setTimeout(() => {
      this.compiledCacheWriteTimer = undefined
      void this.flushCompiledCacheWrites()
    }, 1_200)
  }

  private async flushCompiledCacheWrites(): Promise<void> {
    if (this.compiledCacheWriteTimer !== undefined) {
      clearTimeout(this.compiledCacheWriteTimer)
      this.compiledCacheWriteTimer = undefined
    }
    if (this.compiledCacheWritePromise) {
      await this.compiledCacheWritePromise
      if (this.pendingCompiledCacheWrites.size > 0) {
        await this.flushCompiledCacheWrites()
      }
      return
    }
    const save = this.storage.saveCompiledSections
    if (
      !save ||
      this.compiledCacheWritesDisabled ||
      this.pendingCompiledCacheWrites.size === 0
    ) {
      return
    }

    const pending = [...this.pendingCompiledCacheWrites.values()]
    this.pendingCompiledCacheWrites.clear()
    const records = (
      await Promise.all(
        pending.map(async (candidate) => {
          if (
            candidate.generation !== this.compiledCacheGeneration ||
            candidate.section.revision !== candidate.revision ||
            this.partition.get(candidate.section.key) !== candidate.section
          ) {
            return undefined
          }
          return {
            sectionId: candidate.section.id,
            signature: await this.compiledCacheSignature(candidate.section),
            compiled: candidate.compiled,
          } satisfies CompiledSectionCacheRecord
        }),
      )
    ).filter(
      (record): record is CompiledSectionCacheRecord => record !== undefined,
    )
    if (records.length === 0) return

    const write = save.call(this.storage, 'default', records)
    this.compiledCacheWritePromise = write
    try {
      await write
      for (const record of records) {
        this.persistedCompiledSectionIds.add(record.sectionId)
      }
    } catch (error) {
      // Quota denial and private-mode IndexedDB failures should not affect the
      // authoritative worker path. Stop retrying for this WorldTerrain instance.
      this.compiledCacheWritesDisabled = true
      this.pendingCompiledCacheWrites.clear()
      this.warnCompiledCache('Compiled terrain cache write failed', error)
    } finally {
      this.compiledCacheWritePromise = undefined
      if (
        this.pendingCompiledCacheWrites.size > 0 &&
        this.compiledCacheWriteTimer === undefined
      ) {
        this.compiledCacheWriteTimer = setTimeout(() => {
          this.compiledCacheWriteTimer = undefined
          void this.flushCompiledCacheWrites()
        }, 1_200)
      }
    }
  }

  private resetCompiledCacheState(): void {
    this.compiledCacheGeneration += 1
    this.persistedCompiledSectionIds.clear()
    this.cacheLookupEligibleIds.clear()
    this.pendingCacheLookups.clear()
    this.cacheLookupsInFlight.clear()
    this.pendingCompiledCacheWrites.clear()
    this.bestCompiledCacheWrites.clear()
    this.warmCacheStartup = false
    if (this.compiledCacheWriteTimer !== undefined) {
      clearTimeout(this.compiledCacheWriteTimer)
      this.compiledCacheWriteTimer = undefined
    }
  }

  private warnCompiledCache(message: string, error: unknown): void {
    if (this.warnedAboutCompiledCache) return
    this.warnedAboutCompiledCache = true
    console.warn(`${message}; compiling live instead`, error)
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

  private invalidate(bounds: AABB): TerrainSection[] {
    const invalidated = this.partition.invalidateBounds(
      bounds,
      this.config.operationHalo,
    )
    this.terrainStateRevision += 1
    this.hasPendingTerrainWork = true
    return invalidated
  }

  private applyIncrementalPaintArtifacts(sections: readonly TerrainSection[]): void {
    for (const section of sections) {
      const previousRevision = section.revision - 1
      const currentArtifact =
        section.pendingCompiled?.sourceRevision === previousRevision
          ? section.pendingCompiled
          : section.compiled?.sourceRevision === previousRevision
            ? section.compiled
            : undefined
      if (!currentArtifact) continue

      const modifiers = materializeModifierTransforms(
        this.modifiers.query(
          expandBounds(section.bounds, this.config.operationHalo),
        ),
      )
      const repainted = repaintCompiledSection(
        currentArtifact,
        section.revision,
        this.config.sectionSize,
        modifiers,
      )
      if (!repainted) continue

      if (section.buildState === 'building') {
        this.compiler.cancel(
          section.key,
          section.buildingRevision ?? previousRevision,
        )
      }
      if (this.partition.acceptCompiled(section, repainted)) {
        this.readySwaps.add(section.id)
        this.queueCompiledCacheWrite(section, repainted)
      }
    }
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
        (this.activeTunnel && intersects(section.bounds, this.activeTunnel.bounds)) ||
        (this.activeDig && intersects(section.bounds, this.activeDig.modifier.bounds)))
    ) {
      return
    }
    if (
      section.buildState === 'building' &&
      section.buildingRevision === section.revision &&
      (section.buildingLod ?? 0) <= minimumLod
    ) {
      // The job in flight is at least as detailed as what is wanted. If the
      // camera has since moved far enough that it is now *much* too detailed,
      // coarsen it in place -- otherwise a fly-over leaves a trail of finest
      // level compiles that the pool works through long after the camera has
      // gone, which is what made the view ahead wait tens of seconds.
      if (
        (section.buildingLod ?? 0) < minimumLod - LOD_RECLAIM_SLACK &&
        this.compiler.retarget(
          section.key,
          section.revision,
          requestedLevels(minimumLod, this.config.lodResolutions.length),
          candidate.priority,
        )
      ) {
        section.buildingLod = minimumLod
        return
      }
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
    // Detail is now reclaimed by level rather than by eviction.
    //
    // While terrain existed only near the camera, a section that fell out of
    // range stopped being desired, went untouched and was evicted whole; that
    // was what released the megabyte a finest-level section occupies. Residency
    // now reaches the world edge and nothing ever stops being desired, so
    // without this a section keeps whatever detail it was ever built with for
    // the rest of the session, and flying across the map would accumulate every
    // section at the level it had when the camera passed it.
    //
    // Rebuilding coarse costs at most a few milliseconds -- 3.3 ms at the
    // second-coarsest level against 225 ms at the finest -- so the reclaim is
    // far cheaper than the memory it returns. The slack is what keeps a camera
    // drifting along a level boundary from rebuilding on every frame; a
    // one-level disagreement is left alone.
    const overDetailed = minimumLod > compiledMinimumLod + LOD_RECLAIM_SLACK
    const needsBuild =
      section.buildState === 'queued' ||
      section.buildState === 'failed' ||
      (section.buildState === 'building' &&
        section.buildingRevision !== section.revision) ||
      minimumLod < compiledMinimumLod ||
      overDetailed
    if (!needsBuild) return

    const desiredLevels = requestedLevels(
      minimumLod,
      this.config.lodResolutions.length,
    )
    if (
      overDetailed &&
      section.compiled?.sourceRevision === section.revision
    ) {
      const retained = retainCompiledLevels(section.compiled, desiredLevels)
      if (retained && retained.lods.length === desiredLevels.length) {
        if (this.partition.acceptCompiled(section, retained)) {
          this.readySwaps.add(section.id)
          this.terrainStateRevision += 1
          this.hasPendingTerrainWork = true
        }
        return
      }
    }
    // A warm-start lookup is asynchronous, but it is still dramatically
    // cheaper than starting the same exact CSG job in a worker. Hold this
    // section in the queued state until the batched IndexedDB read resolves.
    if (!section.dirtyRegion && this.requestCompiledCacheLookup(section)) return
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
    const levels = missingCompiledLevels(
      section.compiled,
      desiredLevels,
      section.revision,
    )
    if (levels.length === 0) return
    const jobId = this.compiler.queue(
      section.key,
      section.revision,
      candidate.priority,
      modifiers,
      levels,
      section.source.createCompileSnapshot(
        section.key,
        this.config.sectionSize,
        {
          minSection: this.partition.minSection,
          maxSection: this.partition.maxSection,
        },
      ),
    )
    this.partition.markBuilding(section, jobId, minimumLod, now)
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
    const detailFocusCeiling = this.config.lodDetailFocus
      ? detailFocusLodCeiling(
          section.key,
          this.config.lodDetailFocus,
          this.config.sectionSize,
          lastLevel,
        )
      : lastLevel
    const target = Math.min(
      screenLod,
      focusedLodCeiling(
        cameraDistance,
        this.config.lod0FocusRadiusSections,
        lastLevel,
      ),
      detailFocusCeiling,
    )
    // Detail is earned in two steps rather than demanded in one.
    //
    // A section with nothing compiled yet is asked for a coarse level first,
    // whatever the screen error says: a level-2 compile is a couple of
    // milliseconds against a couple of hundred for the finest one, so this is
    // the difference between the view ahead filling in immediately and it
    // filling in after the pool has ground through every fine job the camera
    // queued on its way here. The finer rebuild follows through the ordinary
    // refinement path once the section is on screen.
    //
    // The same floor applies to everything while the camera is moving quickly,
    // because detail that arrives during the move is detail nobody can see and
    // is usually stale before it lands.
    const floor = Math.max(
      section.compiled ? 0 : COLD_START_LOD_FLOOR,
      this.motionLodFloor(),
    )
    return clamp(Math.max(target, Math.min(floor, lastLevel)), 0, lastLevel)
  }

  /**
   * Coarsest level worth compiling for the speed the camera is travelling at.
   *
   * Hysteretic on purpose: the floor drops back the moment the camera is slow
   * enough that the detail will still be relevant when it arrives, and the
   * refinement path picks the sections up from there.
   */
  private motionLodFloor(): number {
    const speed = this.streamer.horizontalSpeed
    if (speed > FAST_CAMERA_METRES_PER_SECOND) return 2
    if (speed > MOVING_CAMERA_METRES_PER_SECOND) return 1
    return 0
  }

  /**
   * Requeues sections whose worker job never came back.
   *
   * Nothing else notices a lost job: the section stays `building`, so
   * `detectPendingTerrainWork` keeps reporting work in flight and the static
   * fast path stays off permanently. The sweep is the backstop for that whole
   * class of failure rather than for any particular cause of it.
   */
  private sweepStuckBuilds(now: number): void {
    if (now - this.lastStuckSweepAt < STUCK_BUILD_SWEEP_MS) return
    this.lastStuckSweepAt = now
    let recovered = 0
    for (const section of this.partition.values()) {
      if (section.buildState !== 'building') continue
      const status = section.buildJobId === undefined
        ? undefined
        : this.compiler.jobStatus(section.buildJobId)
      // A section becomes `building` when it enters the priority queue, not
      // when a worker starts it. Neither main-queue wait nor a message buffered
      // behind synchronous CSG is evidence of a lost compile.
      if (
        status?.state === 'queued' ||
        status?.state === 'worker-buffered'
      ) {
        continue
      }
      const startedAt = status?.state === 'compiling'
        ? status.startedAt
        : section.buildStartedAt ?? now
      if (now - startedAt < STUCK_BUILD_MS) continue
      this.compiler.cancel(section.key, section.buildingRevision)
      section.buildJobId = undefined
      section.buildingRevision = undefined
      section.buildingLod = undefined
      section.buildStartedAt = undefined
      section.buildState = 'queued'
      recovered += 1
    }
    if (recovered === 0) return
    console.warn(
      `Terrain: requeued ${recovered} section(s) whose compile never returned`,
    )
    this.terrainStateRevision += 1
    this.hasPendingTerrainWork = true
  }

  /**
   * Decides what each section needs, newest and nearest first.
   *
   * Servicing every candidate every frame is what made flying expensive: at
   * world residency that is a thousand build decisions, a thousand residency
   * writes and a thousand renderer state pokes per frame, and all but a handful
   * of them reach the same conclusion they reached on the previous frame. The
   * list arrives sorted by streaming priority, so the head of it -- what is in
   * front of the camera -- is serviced on every frame, and the tail is walked
   * by a rotating cursor that covers the whole world within a few frames.
   */
  private serviceCandidates(
    candidates: readonly StreamCandidate[],
    input: TerrainUpdateInput,
    now: number,
  ): void {
    const total = candidates.length
    if (total === 0) return
    const hot = Math.min(total, HOT_CANDIDATES_PER_FRAME)
    const cold = Math.min(
      Math.max(0, total - hot),
      COLD_CANDIDATES_PER_FRAME,
    )
    for (let index = 0; index < hot; index += 1) {
      this.serviceCandidate(candidates[index], input, now)
    }
    if (cold === 0) {
      this.serviceCursor = 0
      return
    }
    const span = total - hot
    for (let step = 0; step < cold; step += 1) {
      const index = hot + ((this.serviceCursor + step) % span)
      this.serviceCandidate(candidates[index], input, now)
    }
    this.serviceCursor = (this.serviceCursor + cold) % span
  }

  private serviceCandidate(
    candidate: StreamCandidate,
    input: TerrainUpdateInput,
    now: number,
  ): void {
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
    if (this.renderer?.has(section.id)) {
      this.renderer.setVisible(section.id, candidate.visible)
      section.residency = candidate.visible ? 'VISIBLE' : 'GPU_RESIDENT'
    }
    const minimumLod = this.minimumBuildLod(section, candidate, input)
    section.requestedLod = minimumLod
    this.maybeQueueBuild(section, candidate, minimumLod, now)
    this.renderer?.setSectionState(section)
  }

  /**
   * Presents finished compiles.
   *
   * Driven by a set the compiler fills rather than by scanning the candidate
   * list, so a result lands on the frame after it arrives no matter where its
   * section sits in the servicing rotation.
   */
  private scheduleReadySwaps(
    candidateMap: ReadonlyMap<SectionId, StreamCandidate>,
  ): void {
    if (this.readySwaps.size === 0) return
    for (const id of [...this.readySwaps]) {
      const candidate = candidateMap.get(id)
      const section = candidate ? this.partition.get(candidate.key) : undefined
      if (!section || !section.pendingCompiled) {
        this.readySwaps.delete(id)
        continue
      }
      this.maybeScheduleSwap(section, candidate!)
    }
  }

  private cancelDepartedBuilds(departed: readonly SectionId[]): void {
    for (const id of departed) {
      const section = this.partition.get(parseSectionId(id))
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
      // A first guess only: the scheduler replaces this with what swaps are
      // measured to cost as soon as it has run one. It used to say 0.42 while
      // really costing tens of milliseconds, because `upload` built geometry
      // for all five levels; it now builds the one being displayed.
      estimatedCpuMs: 2.5,
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
        // The upload decides its own starting level from what the compile
        // actually produced, so the cached selection is no longer authoritative.
        this.selectedLod.delete(section.id)
        this.lodSelectionDistance.delete(section.id)
        this.requestedRendererLod.delete(section.id)
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
    // Screen-space LOD is a function of the camera, the viewport and the frame
    // quality scale. None of those change while the camera sits still, and
    // re-deriving the same answer for a thousand sections -- plus the
    // neighbour-constraint relaxation over all of them -- was several
    // milliseconds of every frame that had any other reason to run. Sections
    // the selection has never seen are still evaluated, so a section arriving
    // from the streamer picks up its level on the frame it lands.
    const qualityScale = this.scheduler.snapshot().qualityScale
    if (
      this.lodSelectionQuality !== qualityScale ||
      this.lodSelectionViewportHeight !== input.viewportHeight ||
      this.lodSelectionFov !== input.verticalFovRadians
    ) {
      // Everything the cache holds was chosen against a different projection.
      this.selectedLod.clear()
      this.lodSelectionDistance.clear()
      this.lodSelectionQuality = qualityScale
      this.lodSelectionViewportHeight = input.viewportHeight
      this.lodSelectionFov = input.verticalFovRadians
    }
    const editing = Boolean(this.activeStroke || this.activeDig || this.activeTunnel)
    const errorTolerancePixels =
      this.config.baseLodErrorPixels / Math.max(0.48, qualityScale)
    const lastLevel = this.config.lodResolutions.length - 1
    const nodes = this.lodNodes
    nodes.length = 0
    let changed = false

    for (const candidate of candidates) {
      const section = this.partition.get(candidate.key)
      if (!section || !section.compiled || !this.renderer.has(section.id)) continue
      const centerX = (section.bounds.min.x + section.bounds.max.x) * 0.5
      const centerY =
        (section.compiled.bounds.min.y + section.compiled.bounds.max.y) * 0.5
      const centerZ = (section.bounds.min.z + section.bounds.max.z) * 0.5
      const distance = Math.hypot(
        input.camera.x - centerX,
        input.camera.y - centerY,
        input.camera.z - centerZ,
      )
      // Screen error scales with 1/distance, so what decides whether a section
      // can keep its level is not how far the camera moved but how far it moved
      // relative to how far away the section already was. A camera crossing the
      // map re-selects for the ground it is passing over and leaves the horizon
      // alone, which is where nearly all of the thousand sections are.
      const previousDistance = this.lodSelectionDistance.get(section.id)
      const settled =
        !editing &&
        previousDistance !== undefined &&
        Math.abs(distance - previousDistance) <=
          Math.max(
            LOD_SELECTION_EPSILON_METRES,
            previousDistance * LOD_SELECTION_DISTANCE_BAND,
          )
      const previous = this.selectedLod.get(section.id)
      const cached = settled ? previous : undefined
      let lod = cached
      if (lod === undefined) {
        this.lodSelectionDistance.set(section.id, distance)
        lod = selectLod({
          lods: section.compiled.lods,
          distance,
          viewportHeight: input.viewportHeight,
          verticalFovRadians: input.verticalFovRadians,
          errorTolerancePixels,
          currentLod: section.activeLod,
          focusDistanceSections: cameraSectionDistance(
            candidate.key,
            input.camera,
            this.config.sectionSize,
          ),
          lod0FocusRadiusSections: this.config.lod0FocusRadiusSections,
        })
        if (this.config.lodDetailFocus) {
          lod = Math.min(
            lod,
            detailFocusLodCeiling(
              section.key,
              this.config.lodDetailFocus,
              this.config.sectionSize,
              lastLevel,
            ),
          )
        }
      }
      const activeBrushTouchesSection = Boolean(
        (this.activeStroke &&
          this.liveStrokePoint &&
          distanceToAabb(this.liveStrokePoint, section.bounds) <=
            this.activeStroke.radius) ||
          (this.activeDig &&
            distanceToAabb(this.activeDig.capsule.end, section.bounds) <=
              this.activeDig.radius),
      )
      if (activeBrushTouchesSection || section.dirtyRegion) lod = 0
      // What matters for the neighbour constraint is whether a level actually
      // moved, not whether it was re-derived. Recomputing usually confirms the
      // level a section already had, and running the relaxation for that is
      // several hundred thousand wasted comparisons.
      if (lod !== previous) {
        changed = true
        this.selectedLod.set(section.id, lod)
      }
      section.requestedLod = lod
      let node = this.lodNodeRecords.get(section.id)
      if (!node) {
        node = { id: section.id, x: section.key.x, z: section.key.z, lod }
        this.lodNodeRecords.set(section.id, node)
      }
      node.lod = lod
      nodes.push(node)
    }
    if (nodes.length !== this.constrainedLod.size) changed = true

    // The relaxation only has anything to do when a level actually moved.
    if (changed) this.constrainedLod = constrainNeighborLods(nodes)
    for (const [id, lod] of this.constrainedLod) this.requestRendererLod(id, lod)
  }

  /**
   * A level swap materialises geometry for a level this section has never
   * displayed, which is real main-thread work and belongs under the same budget
   * as an upload rather than running for every section in the frame that
   * decides it. Anything already built makes this a pointer swap and the
   * scheduler measures it as such.
   */
  private requestRendererLod(id: SectionId, lod: number): void {
    if (this.requestedRendererLod.get(id) === lod) return
    this.requestedRendererLod.set(id, lod)
    this.scheduler.enqueue({
      id: `lod:${id}`,
      kind: 'swap',
      // Constant so a later request always replaces an earlier queued one:
      // `enqueue` keeps the higher priority, and a stale level must never win.
      priority: 900,
      estimatedCpuMs: 0.6,
      run: () => this.renderer?.setLod(id, lod),
    })
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

  /**
   * Merging distant sections is opportunistic maintenance, so it queues behind
   * anything the frame actually needs and is bounded to a couple of merges.
   */
  private scheduleSectionBatching(now: number): void {
    this.scheduler.enqueue({
      id: 'batch:sections',
      kind: 'maintenance',
      priority: -80,
      estimatedCpuMs: 1.2,
      run: () => this.renderer?.flushSectionBatches(now, 2),
    })
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
          this.selectedLod.delete(id)
          this.lodNodeRecords.delete(id)
          this.lodSelectionDistance.delete(id)
          this.constrainedLod.delete(id)
          this.requestedRendererLod.delete(id)
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
            if (this.persistedCompiledSectionIds.has(id)) {
              this.cacheLookupEligibleIds.add(id)
            }
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
        accumulate: stroke.accumulate,
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
    candidates: ReadonlyMap<SectionId, StreamCandidate>,
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
    let failed = 0
    for (const section of this.partition.values()) {
      if (section.buildState === 'failed') failed += 1
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
      failedSections: failed,
      lastCompileError: failed > 0 ? this.lastCompileError : null,
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

function createDigCapsule(
  entry: Vec3Like,
  direction: Vec3Like,
  radius: number,
  length: number,
  noise: number,
  noiseScale: number,
): CapsuleCutter {
  return {
    kind: 'capsule',
    start: addScaled(entry, direction, -radius * 0.22),
    end: addScaled(entry, direction, length),
    radius,
    surface: 'cave',
    noise: Math.max(0, noise),
    noiseScale: Math.max(0.25, noiseScale),
  }
}

function appendDigCapsule(
  modifier: DigTargetModifier,
  capsule: CapsuleCutter,
): void {
  if (modifier.type === 'boolean-subtract') {
    if (!modifier.carves) modifier.carves = []
    modifier.carves.push(capsule)
    return
  }
  modifier.volumes.push(capsule)
}

function digDirection(ray: CameraDigRay | undefined, normal: Vec3Like): Vec3Like {
  const value = ray?.direction ?? {
    x: -normal.x,
    y: -normal.y,
    z: -normal.z,
  }
  const length = Math.hypot(value.x, value.y, value.z)
  if (length < 1e-8) return { x: 0, y: -1, z: 0 }
  return { x: value.x / length, y: value.y / length, z: value.z / length }
}

function addScaled(
  point: Vec3Like,
  direction: Vec3Like,
  scale: number,
): Vec3Like {
  return {
    x: point.x + direction.x * scale,
    y: point.y + direction.y * scale,
    z: point.z + direction.z * scale,
  }
}

function distance3(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function dot3(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/**
 * A stable 0..1 draw from three integers.
 *
 * Rock placement has to be a pure function of the world seed: the same world
 * must plant the same erratics in the same places on every machine and on every
 * reload, and `Math.random` cannot promise that.
 */
function hashUnit(a: number, b: number, seed: number): number {
  let h = Math.imul(a ^ 0x9e37_79b9, 0x85eb_ca6b)
  h = Math.imul(h ^ b ^ 0xc2b2_ae35, 0x27d4_eb2f)
  h = Math.imul(h ^ seed, 0x165_667b1)
  h ^= h >>> 15
  return ((h >>> 0) % 100_003) / 100_003
}
