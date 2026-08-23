import { sectionId } from '../core/bounds'
import type { TerrainConfig } from '../config'
import type { CompiledSection, SectionId, SectionKey } from '../core/types'
import type { TerrainSectionSourceSnapshot } from '../mesh/EditableMesh'
import type { TerrainModifier } from '../modifiers/types'
import type {
  CompileSectionRequest,
  TerrainWorkerResponse,
} from './protocol'
import { encodeModifiers, sourceTransferables } from './protocol'

interface WorkerSlot {
  index: number
  worker: Worker
  /** Dispatched and not yet answered, in the order the worker will do them. */
  inFlight: CompileSectionRequest[]
}

/**
 * How many jobs a worker may hold at once.
 *
 * A worker's own message queue serialises them, so this is purely about never
 * making the worker wait for the main thread. `dispatch` runs from the result
 * handler, which means a slot holding exactly one job goes idle the moment it
 * answers and stays idle until the main thread gets round to the reply -- and
 * the main thread is busy rendering. Measured against the shipped scene, that
 * left the pool 43% utilised: workers spent 25 ms idle per job to do 1.4 ms of
 * work. Holding a couple of jobs in reserve covers a slow frame without
 * hoarding so much of the queue that a camera move throws away real work.
 */
const WORKER_PIPELINE_DEPTH = 3

interface QueuedJob {
  request: CompileSectionRequest
  submittedAt: number
}

export interface TerrainWorkerPoolStats {
  active: number
  queued: number
  cancelled: number
  stale: number
}

export interface TerrainWorkerCancellation {
  queued: number
  active: number
}

export type TerrainWorkerJobStatus =
  | { readonly state: 'queued' | 'worker-buffered' }
  | { readonly state: 'compiling'; readonly startedAt: number }

export type WorkerResultHandler = (
  result:
    | { ok: true; jobId: number; compiled: CompiledSection }
    | {
        ok: false
        jobId: number
        key: SectionKey
        revision: number
        error: string
        /**
         * The section itself is fine; the pool lost the job. The owner should
         * put it back in the queue rather than showing it as a failed build.
         */
        retryable?: boolean
      },
) => void

export class TerrainWorkerPool {
  private readonly config: TerrainConfig
  private readonly pipelineDepth: number
  private slots: WorkerSlot[] = []
  /**
   * At most one waiting job per section, indexed by it.
   *
   * `submit` already guaranteed that invariant -- a new request drops any
   * earlier one for the same section -- but the queue was a plain array, so
   * every submit, cancel, retarget and reprioritise scanned all of it. With a
   * thousand sections streaming and a few hundred reprioritised per frame that
   * is hundreds of thousands of comparisons a frame, and it was the largest
   * single cost of both a cold load and a moving camera.
   */
  private queued = new Map<SectionId, QueuedJob>()
  /** Priority order, rebuilt from `queued` only when something has changed. */
  private queueOrder: QueuedJob[] = []
  private nextJobId = 1
  private queueDirty = false
  private cancelled = 0
  private stale = 0
  private latestRevision = new Map<string, number>()
  /** Lifecycle ownership for the streamer's lost-job recovery sweep. */
  private jobStatuses = new Map<number, TerrainWorkerJobStatus>()
  onResult?: WorkerResultHandler

  constructor(
    workerCount: number,
    config: TerrainConfig,
    pipelineDepth: number = WORKER_PIPELINE_DEPTH,
  ) {
    this.config = config
    this.pipelineDepth = Math.max(1, Math.floor(pipelineDepth))
    for (let index = 0; index < workerCount; index += 1) {
      const slot: WorkerSlot = { index, inFlight: [], worker: undefined! }
      this.installWorker(slot)
      this.slots.push(slot)
    }
  }

  submit(
    key: SectionKey,
    revision: number,
    priority: number,
    modifiers: TerrainModifier[],
    levels?: readonly number[],
    source?: TerrainSectionSourceSnapshot,
  ): number {
    const id = sectionId(key)
    this.latestRevision.set(id, revision)
    const superseded = this.queued.get(id)
    if (superseded) {
      if (superseded.request.revision > revision) {
        // A newer revision is already waiting; this request is the stale one.
        this.cancelled += 1
        return superseded.request.jobId
      }
      this.jobStatuses.delete(superseded.request.jobId)
      this.cancelled += 1
    }

    const jobId = this.nextJobId++
    this.queued.set(id, {
      request: {
        kind: 'compile-section',
        jobId,
        key: { ...key },
        revision,
        priority,
        config: {
          sectionSize: this.config.sectionSize,
          lodResolutions: this.config.lodResolutions,
          seed: this.config.seed,
          operationHalo: this.config.operationHalo,
          worldProfile: this.config.worldProfile,
        },
        levels: levels ? [...levels] : undefined,
        source,
        modifiers: encodeModifiers(modifiers),
      },
      submittedAt: performance.now(),
    })
    this.jobStatuses.set(jobId, { state: 'queued' })
    this.queueDirty = true
    this.dispatch()
    return jobId
  }

  cancelSection(
    key: SectionKey,
    beforeRevision = Infinity,
  ): TerrainWorkerCancellation {
    const id = sectionId(key)
    let queuedCount = 0
    let activeCount = 0
    const waiting = this.queued.get(id)
    if (waiting && waiting.request.revision <= beforeRevision) {
      this.queued.delete(id)
      this.jobStatuses.delete(waiting.request.jobId)
      this.queueDirty = true
      this.cancelled += 1
      queuedCount += 1
    }

    // Worker computation is synchronous, so a message cannot interrupt it.
    // Terminate and replace the module instead: departed travel work must not
    // hold a slot for seconds while relevant sections pile up behind it.
    for (const slot of this.slots) {
      const doomed = slot.inFlight.filter(
        (request) =>
          sectionId(request.key) === id && request.revision <= beforeRevision,
      )
      if (doomed.length === 0) continue
      const survivors = slot.inFlight.filter(
        (request) => !doomed.includes(request),
      )
      this.cancelled += doomed.length
      activeCount += doomed.length
      this.restartWorker(slot, survivors)
    }
    this.dispatch()
    return { queued: queuedCount, active: activeCount }
  }

  /**
   * Coarsens a job that has not started yet.
   *
   * Flying across the map queues fine detail for everything the camera passes
   * over, and by the time a worker reaches those jobs the camera is kilometres
   * away and needs a fraction of the detail. The queued request has not been
   * transferred anywhere yet, so the level set can simply be rewritten -- far
   * cheaper than cancelling the job and building a fresh snapshot, and unlike
   * cancelling it cannot disturb a worker that is mid-compile.
   *
   * Returns false when there is no queued job to retarget, which includes the
   * case where it is already in flight.
   */
  retargetQueued(
    key: SectionKey,
    revision: number,
    levels: readonly number[],
    priority: number,
  ): boolean {
    const waiting = this.queued.get(sectionId(key))
    if (!waiting || waiting.request.revision !== revision) return false
    waiting.request.levels = [...levels]
    waiting.request.priority = priority
    this.queueDirty = true
    return true
  }

  reprioritizeSection(
    key: SectionKey,
    revision: number,
    priority: number,
  ): boolean {
    const waiting = this.queued.get(sectionId(key))
    if (
      !waiting ||
      waiting.request.revision !== revision ||
      waiting.request.priority === priority
    ) {
      return false
    }
    waiting.request.priority = priority
    this.queueDirty = true
    return true
  }

  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate()
    this.slots = []
    this.queued.clear()
    this.queueOrder.length = 0
    this.jobStatuses.clear()
  }

  stats(): TerrainWorkerPoolStats {
    return {
      active: this.slots.reduce((count, slot) => count + slot.inFlight.length, 0),
      queued: this.queued.size,
      cancelled: this.cancelled,
      stale: this.stale,
    }
  }

  /** Exact lifecycle state used to avoid timing queue wait as compile time. */
  jobStatus(jobId: number): TerrainWorkerJobStatus | undefined {
    return this.jobStatuses.get(jobId)
  }

  private dispatch(): void {
    // Breadth first: every slot gets its first job before any gets a second, so
    // a short queue still spreads across the pool instead of piling onto one
    // worker while the others stand idle.
    let exactSlots = this.slots.reduce(
      (count, slot) =>
        count + (slot.inFlight.some(isExactBooleanRequest) ? 1 : 0),
      0,
    )
    for (let depth = 0; depth < this.pipelineDepth; depth += 1) {
      for (const slot of this.slots) {
        if (slot.inFlight.length > depth) continue
        // Exact mesh CSG takes seconds rather than milliseconds. Posting more
        // work behind it hides that work from reprioritisation and makes a
        // cancelled Boolean take unrelated jobs down with its worker. Cheap
        // jobs retain the short pipeline that keeps workers supplied.
        if (slot.inFlight.some(isExactBooleanRequest)) continue
        // Preserve one latency lane while exact CSG is backlogged. Otherwise a
        // handful of multi-second landmark cells occupy every worker and make
        // the ordinary millisecond terrain around them appear to stop loading.
        const reserveOrdinary =
          this.slots.length > 1 && exactSlots >= this.slots.length - 1
        const job = reserveOrdinary
          ? this.nextJob(true) ??
            // Do not hide another exact job behind ordinary work in the
            // reserved lane. If no ordinary work exists at all then an empty
            // worker may still join the CSG backlog.
            (slot.inFlight.length === 0 ? this.nextJob() : undefined)
          : this.nextJob()
        if (!job) continue
        this.send(slot, job)
        if (isExactBooleanRequest(job)) exactSlots += 1
      }
    }
  }

  /**
   * The next job still worth doing.
   *
   * A queued revision can be overtaken while it waits, and starting it then
   * spends a worker on a result `handleMessage` is going to throw away. The
   * queue prune in `submit` catches the common case, but only for jobs queued
   * at the time; this is the check at the point of use.
   */
  private nextJob(ordinaryOnly = false): CompileSectionRequest | undefined {
    // Ordered at the point of use. Reprioritising is a per-frame, per-section
    // event while the camera moves, and re-sorting on each of those was a
    // measurable share of the frame on its own.
    if (this.queueDirty) this.sortQueue()
    for (let index = this.queueOrder.length - 1; index >= 0; index -= 1) {
      const job = this.queueOrder[index]
      if (ordinaryOnly && isExactBooleanRequest(job.request)) continue
      this.queueOrder.splice(index, 1)
      const id = sectionId(job.request.key)
      // The order is a snapshot: an entry can have been replaced or cancelled
      // since it was taken.
      if (this.queued.get(id) !== job) continue
      this.queued.delete(id)
      const latest = this.latestRevision.get(id)
      if (latest !== undefined && job.request.revision < latest) {
        this.jobStatuses.delete(job.request.jobId)
        this.cancelled += 1
        continue
      }
      return job.request
    }
    return undefined
  }

  private send(slot: WorkerSlot, request: CompileSectionRequest): void {
    slot.inFlight.push(request)
    this.jobStatuses.set(request.jobId, { state: 'worker-buffered' })
    try {
      slot.worker.postMessage(request, [
        request.modifiers.brushPoints.buffer,
        ...sourceTransferables(request.source),
      ])
    } catch (error) {
      // A send that throws never reaches the worker, so no reply is coming.
      // Leaving the request in `inFlight` would retire that much of the slot's
      // pipeline permanently and leave the section building for the rest of the
      // session -- which is what kept the streaming fast path switched off and
      // cost several milliseconds of scheduling on every subsequent frame.
      const position = slot.inFlight.indexOf(request)
      if (position !== -1) slot.inFlight.splice(position, 1)
      this.failJob(request, `Terrain worker send failed: ${String(error)}`)
    }
  }

  /** Reports a job the pool could not run, so its owner can queue it again. */
  private failJob(request: CompileSectionRequest, error: string): void {
    this.jobStatuses.delete(request.jobId)
    this.onResult?.({
      ok: false,
      jobId: request.jobId,
      key: request.key,
      revision: request.revision,
      error,
      retryable: true,
    })
  }

  private handleMessage(slot: WorkerSlot, response: TerrainWorkerResponse): void {
    const position = slot.inFlight.findIndex(
      (request) => request.jobId === response.jobId,
    )
    // Not ours: a reply from a worker this slot has since replaced.
    if (position === -1) return
    if (response.kind === 'compile-started') {
      this.jobStatuses.set(response.jobId, {
        state: 'compiling',
        startedAt: performance.now(),
      })
      return
    }
    slot.inFlight.splice(position, 1)
    this.jobStatuses.delete(response.jobId)
    const id = sectionId(response.key)
    const latest = this.latestRevision.get(id) ?? response.revision
    if (response.revision < latest) {
      this.stale += 1
      this.dispatch()
      return
    }

    if (response.kind === 'compile-success') {
      this.onResult?.({ ok: true, jobId: response.jobId, compiled: response.compiled })
    } else {
      this.onResult?.({
        ok: false,
        jobId: response.jobId,
        key: response.key,
        revision: response.revision,
        error: response.error,
      })
    }
    this.dispatch()
  }

  private handleWorkerError(slot: WorkerSlot, error: string): void {
    const failed = slot.inFlight
    slot.inFlight = []
    for (const request of failed) {
      this.jobStatuses.delete(request.jobId)
      this.onResult?.({
        ok: false,
        jobId: request.jobId,
        key: request.key,
        revision: request.revision,
        error,
      })
    }
    this.dispatch()
  }

  private installWorker(slot: WorkerSlot): void {
    const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), {
      type: 'module',
      name: `terrain-compiler-${slot.index}`,
    })
    slot.worker = worker
    worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
      if (slot.worker === worker) this.handleMessage(slot, event.data)
    }
    worker.onerror = (event) => {
      if (slot.worker === worker) this.handleWorkerError(slot, event.message)
    }
  }

  /**
   * Replaces the module and returns whatever it was holding to the queue.
   *
   * Terminating is the only way to stop synchronous work, and with a pipeline
   * it takes the slot's untouched jobs down with the one being cancelled. Those
   * are still wanted, so they go back to the queue rather than being dropped.
   */
  /**
   * Replaces a worker, giving up on whatever else it was holding.
   *
   * The survivors cannot simply be pushed back on the queue: their source
   * buffers were transferred to the worker being terminated and are detached,
   * so re-sending them throws `DataCloneError` and takes the slot down with it.
   * Reporting them as retryable hands the decision back to the owner, which
   * still has the authoritative mesh and can build a fresh snapshot.
   */
  private restartWorker(slot: WorkerSlot, orphaned: CompileSectionRequest[]): void {
    for (const request of slot.inFlight) {
      this.jobStatuses.delete(request.jobId)
    }
    slot.worker.terminate()
    slot.inFlight = []
    this.installWorker(slot)
    for (const request of orphaned) {
      this.failJob(request, 'Terrain worker restarted before this job ran')
    }
  }

  /** Rebuilds the dispatch order, lowest priority first so it can be popped. */
  private sortQueue(): void {
    this.queueDirty = false
    this.queueOrder.length = 0
    for (const job of this.queued.values()) this.queueOrder.push(job)
    this.queueOrder.sort((a, b) => {
      if (a.request.priority !== b.request.priority) {
        return a.request.priority - b.request.priority
      }
      return b.submittedAt - a.submittedAt
    })
  }
}

function isExactBooleanRequest(request: CompileSectionRequest): boolean {
  return request.modifiers.descriptors.some(
    (modifier) =>
      modifier.enabled &&
      (modifier.type === 'boolean-subtract' ||
        modifier.type === 'boolean-volume'),
  )
}
