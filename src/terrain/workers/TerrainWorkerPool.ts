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
  worker: Worker
  jobId?: number
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
      const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), {
        type: 'module',
        name: `terrain-compiler-${index}`,
      })
      const slot: WorkerSlot = { worker }
      worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) =>
        this.handleMessage(slot, event.data)
      worker.onerror = (event) => this.handleWorkerError(slot, event.message)
      this.slots.push(slot)
    }
  }

  submit(
    key: SectionKey,
    revision: number,
    priority: number,
    modifiers: TerrainModifier[],
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
        modifiers: encodeModifiers(modifiers),
      },
      submittedAt: performance.now(),
    })
    this.queue.sort((a, b) => {
      if (a.request.priority !== b.request.priority) {
        return b.request.priority - a.request.priority
      }
      return a.submittedAt - b.submittedAt
    })
    this.dispatch()
    return jobId
  }

  cancelSection(key: SectionKey, beforeRevision = Infinity): void {
    const id = sectionId(key)
    const retained: QueuedJob[] = []
    for (const queued of this.queue) {
      if (
        sectionId(queued.request.key) === id &&
        queued.request.revision <= beforeRevision
      ) {
        this.cancelled += 1
      } else retained.push(queued)
    }
    this.queue = retained
  }

  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate()
    this.slots = []
    this.queue = []
  }

  stats(): TerrainWorkerPoolStats {
    return {
      active: this.slots.filter((slot) => slot.jobId !== undefined).length,
      queued: this.queue.length,
      cancelled: this.cancelled,
      stale: this.stale,
    }
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.jobId !== undefined) continue
      const job = this.queue.shift()
      if (!job) break
      slot.jobId = job.request.jobId
      slot.worker.postMessage(job.request, [job.request.modifiers.brushPoints.buffer])
    }
  }

  private handleMessage(slot: WorkerSlot, response: TerrainWorkerResponse): void {
    slot.jobId = undefined
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
    const jobId = slot.jobId
    slot.jobId = undefined
    if (jobId !== undefined) {
      this.onResult?.({
        ok: false,
        jobId,
        key: { x: 0, z: 0 },
        revision: -1,
        error,
      })
    }
    this.dispatch()
  }
}
