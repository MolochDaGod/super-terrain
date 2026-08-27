import { LEAF_CARD_VARIANTS } from '../generator/foliageCompiler'
import type { TreeSpecies } from '../generator/types'
import {
  bakeProceduralTreeTextureData,
  type LeafSprayTextureData,
  type ProceduralTreeTextureData,
  type TreeTextureResolution,
} from './proceduralTreeTextures'
import type {
  ProceduralTreeTextureBakeReply,
  TreeTextureBakeRequest,
} from './proceduralTreeTexture.worker'

/**
 * A persistent pool of texture-bake workers.
 *
 * Two things used to make the material stage the slowest part of planting a
 * forest, and neither was the maths.
 *
 * The first is that a bake ran as one indivisible job on one core: bark and
 * eight leaf variants in series, three and a half seconds of it bark. Bark and
 * every leaf variant are independent pure functions of (species, seed, size),
 * so the pool schedules them as nine jobs and a four-core machine finishes a
 * material set in about the time bark alone takes.
 *
 * The second is that every bake span up a fresh module worker, which re-parsed
 * and re-compiled the whole texture module graph before it could evaluate a
 * single texel. A forest of four distinct materials paid that four times.
 * Workers here are created once and reused for the life of the page.
 *
 * Output is byte-identical to the single-threaded bake: this changes where the
 * work runs, never what it computes.
 */

interface Cancellation {
  cancelled: boolean
}

/** `Omit` over a union has to distribute, or every variant loses its shape. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type BakeJobRequest = WithoutId<TreeTextureBakeRequest>

interface PoolJob {
  request: BakeJobRequest
  /** Lower runs first. Longest-job-first keeps the tail short. */
  priority: number
  resolve(reply: ProceduralTreeTextureBakeReply): void
  reject(error: unknown): void
  cancellation: Cancellation
}

interface PoolWorker {
  worker: Worker
  job?: PoolJob
  startedAt?: number
}

/**
 * Per-job timings for the browser review harness. The bake's cost in a real
 * worker under a live renderer is several times what it measures in a Node
 * benchmark, so tuning it from anywhere else is guesswork.
 */
const bakeStats: Array<{ kind: string; species: string; ms: number }> = []
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__treeTextureBakeStats = () => bakeStats
}

/**
 * Leave a core for the main thread and the geometry compiler; past six the
 * pool competes with them for the same cache and the bake stops getting
 * faster. Two is enough to overlap bark with the leaf variants.
 */
function poolSize(): number {
  const cores = typeof navigator === 'undefined'
    ? 4
    : navigator.hardwareConcurrency || 4
  return Math.max(2, Math.min(6, cores - 1))
}

const workers: PoolWorker[] = []
const queue: PoolJob[] = []
let nextJobId = 1

function ensureWorkers(): void {
  if (workers.length > 0) return
  const size = poolSize()
  for (let index = 0; index < size; index += 1) {
    const worker = new Worker(
      new URL('./proceduralTreeTexture.worker.ts', import.meta.url),
      { type: 'module', name: `tree-texture-baker-${index}` },
    )
    const entry: PoolWorker = { worker }
    worker.onmessage = (event: MessageEvent<ProceduralTreeTextureBakeReply>) => {
      const job = entry.job
      entry.job = undefined
      if (import.meta.env?.DEV && job && entry.startedAt !== undefined) {
        bakeStats.push({
          kind: job.request.kind ?? 'set',
          species: job.request.species,
          ms: Math.round(performance.now() - entry.startedAt),
        })
      }
      if (job) {
        if (event.data.kind === 'error') job.reject(new Error(event.data.error))
        else job.resolve(event.data)
      }
      pump()
    }
    worker.onerror = (event) => {
      const job = entry.job
      entry.job = undefined
      job?.reject(new Error(event.message || 'Tree texture bake worker failed'))
      pump()
    }
    worker.onmessageerror = () => {
      const job = entry.job
      entry.job = undefined
      job?.reject(new Error('Tree texture bake worker returned unreadable data'))
      pump()
    }
    workers.push(entry)
  }
}

/**
 * Bark is fifteen to thirty times the cost of one leaf variant, so it is
 * dispatched first. Filling the cores with leaves and leaving a bark job to
 * start last strands one worker on a multi-second job while the others idle.
 */
function jobPriority(request: BakeJobRequest): number {
  return request.kind === 'leaf' ? 1 : 0
}

function pump(): void {
  for (const entry of workers) {
    if (entry.job) continue
    let job = queue.shift()
    while (job?.cancellation.cancelled) job = queue.shift()
    if (!job) return
    entry.job = job
    entry.startedAt = performance.now()
    const id = nextJobId++
    entry.worker.postMessage({ ...job.request, id } as TreeTextureBakeRequest)
  }
}

function submit(
  request: BakeJobRequest,
  cancellation: Cancellation,
): Promise<ProceduralTreeTextureBakeReply> {
  ensureWorkers()
  return new Promise((resolve, reject) => {
    const job: PoolJob = {
      request,
      priority: jobPriority(request),
      resolve,
      reject,
      cancellation,
    }
    const before = queue.findIndex((queued) => queued.priority > job.priority)
    if (before === -1) queue.push(job)
    else queue.splice(before, 0, job)
    pump()
  })
}

export interface TreeTextureBakeJob {
  promise: Promise<ProceduralTreeTextureData>
  cancel(): void
}

/**
 * Bakes a complete material set across the pool.
 *
 * Cancellation drops anything still queued. A job already running is left to
 * finish and its result discarded: at forest resolution the longest of them is
 * a few seconds, and tearing down a pool worker mid-bake would cost every
 * later bake the module compile this pool exists to avoid.
 */
export function bakeTreeTexturesOnPool(
  species: TreeSpecies,
  seed: number,
  resolution: TreeTextureResolution,
): TreeTextureBakeJob {
  if (typeof Worker === 'undefined') return bakeWithoutWorker(species, seed, resolution)

  const cancellation: Cancellation = { cancelled: false }
  const barkJob = submit({ kind: 'bark', species, seed, resolution }, cancellation)
  const leafJobs: Promise<ProceduralTreeTextureBakeReply>[] = []
  for (let variant = 0; variant < LEAF_CARD_VARIANTS; variant += 1) {
    leafJobs.push(
      submit({ kind: 'leaf', species, seed, resolution, variant }, cancellation),
    )
  }
  const promise = Promise.all([barkJob, ...leafJobs]).then((replies) => {
    if (cancellation.cancelled) throw abortError()
    const [bark, ...leaves] = replies
    if (bark?.kind !== 'bark') throw new Error('Tree texture bake returned no bark maps')
    const leafCards: LeafSprayTextureData[] = []
    for (const reply of leaves) {
      if (reply.kind !== 'leaf') throw new Error('Tree texture bake returned no leaf card')
      leafCards[reply.variant] = reply.data
    }
    return { bark: bark.data, leafCards }
  })
  return {
    promise,
    cancel() {
      cancellation.cancelled = true
    },
  }
}

function bakeWithoutWorker(
  species: TreeSpecies,
  seed: number,
  resolution: TreeTextureResolution,
): TreeTextureBakeJob {
  let timer = 0
  let rejectJob: (reason: unknown) => void = () => undefined
  const promise = new Promise<ProceduralTreeTextureData>((resolve, reject) => {
    rejectJob = reject
    // Yield once for SSR/tests and old browsers. The production viewport has
    // Worker support; this fallback preserves correctness, not responsiveness.
    timer = globalThis.setTimeout(
      () => resolve(bakeProceduralTreeTextureData(species, seed, resolution)),
      0,
    ) as unknown as number
  })
  return {
    promise,
    cancel() {
      if (!timer) return
      globalThis.clearTimeout(timer)
      timer = 0
      rejectJob(abortError())
    },
  }
}

function abortError(): DOMException {
  return new DOMException('Tree texture baking was cancelled', 'AbortError')
}
