import { sectionId } from '../core/bounds'
import type { TerrainConfig } from '../config'
import type { CompiledSection, SectionKey } from '../core/types'
import type { TerrainModifier } from '../modifiers/types'
import type {
  CompileSectionRequest,
  TerrainWorkerResponse,
} from './protocol'
import { encodeModifiers } from './protocol'

interface WorkerSlot {
  index: number
  worker: Worker
  request?: CompileSectionRequest
}

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

export type WorkerResultHandler = (
  result:
    | { ok: true; jobId: number; compiled: CompiledSection }
    | { ok: false; jobId: number; key: SectionKey; revision: number; error: string },
) => void

export class TerrainWorkerPool {
  private readonly config: TerrainConfig
  private slots: WorkerSlot[] = []
  private queue: QueuedJob[] = []
  private nextJobId = 1
  private cancelled = 0
  private stale = 0
  private latestRevision = new Map<string, number>()
  onResult?: WorkerResultHandler

  constructor(workerCount: number, config: TerrainConfig) {
    this.config = config
    for (let index = 0; index < workerCount; index += 1) {
      const slot = { index } as WorkerSlot
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
  ): number {
    const id = sectionId(key)
    this.latestRevision.set(id, revision)
    const retained: QueuedJob[] = []
    for (const queued of this.queue) {
      if (sectionId(queued.request.key) === id && queued.request.revision <= revision) {
        this.cancelled += 1
      } else retained.push(queued)
    }
    this.queue = retained

    const jobId = this.nextJobId++
    this.queue.push({
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
        },
        levels: levels ? [...levels] : undefined,
        modifiers: encodeModifiers(modifiers),
      },
      submittedAt: performance.now(),
    })
    this.sortQueue()
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
    const retained: QueuedJob[] = []
    for (const queued of this.queue) {
      if (
        sectionId(queued.request.key) === id &&
        queued.request.revision <= beforeRevision
      ) {
        this.cancelled += 1
        queuedCount += 1
      } else retained.push(queued)
    }
    this.queue = retained

    // Worker computation is synchronous, so a message cannot interrupt it.
    // Terminate and replace the module instead: departed travel work must not
    // hold a slot for seconds while relevant sections pile up behind it.
    for (const slot of this.slots) {
      const request = slot.request
      if (
        request &&
        sectionId(request.key) === id &&
        request.revision <= beforeRevision
      ) {
        this.cancelled += 1
        activeCount += 1
        this.restartWorker(slot)
      }
    }
    this.dispatch()
    return { queued: queuedCount, active: activeCount }
  }

  reprioritizeSection(
    key: SectionKey,
    revision: number,
    priority: number,
  ): boolean {
    const id = sectionId(key)
    let changed = false
    for (const queued of this.queue) {
      if (
        sectionId(queued.request.key) === id &&
        queued.request.revision === revision &&
        queued.request.priority !== priority
      ) {
        queued.request.priority = priority
        changed = true
      }
    }
    if (changed) this.sortQueue()
    return changed
  }

  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate()
    this.slots = []
    this.queue = []
  }

  stats(): TerrainWorkerPoolStats {
    return {
      active: this.slots.filter((slot) => slot.request !== undefined).length,
      queued: this.queue.length,
      cancelled: this.cancelled,
      stale: this.stale,
    }
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.request !== undefined) continue
      const job = this.queue.shift()
      if (!job) break
      slot.request = job.request
      slot.worker.postMessage(job.request, [job.request.modifiers.brushPoints.buffer])
    }
  }

  private handleMessage(slot: WorkerSlot, response: TerrainWorkerResponse): void {
    if (slot.request?.jobId !== response.jobId) return
    slot.request = undefined
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
    const request = slot.request
    slot.request = undefined
    if (request) {
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

  private restartWorker(slot: WorkerSlot): void {
    slot.worker.terminate()
    slot.request = undefined
    this.installWorker(slot)
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      if (a.request.priority !== b.request.priority) {
        return b.request.priority - a.request.priority
      }
      return a.submittedAt - b.submittedAt
    })
  }
}
