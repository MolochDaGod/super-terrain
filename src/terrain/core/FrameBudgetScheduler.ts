import { clamp, lerp } from './bounds'
import type { FrameBudget, FrameBudgetSnapshot } from './types'

export type TerrainTaskKind = 'maintenance' | 'upload' | 'swap'

export interface TerrainTask {
  id: string
  kind: TerrainTaskKind
  priority: number
  estimatedCpuMs: number
  uploadBytes?: number
  swaps?: number
  run: () => void
}

export interface SchedulerOptions extends FrameBudget {
  targetFrameMs?: number
}

/**
 * How quickly a class of task forgets what it used to cost. Low enough that one
 * unusually dense section cannot make the scheduler pessimistic for long, high
 * enough that a real change in cost is picked up within a handful of frames.
 */
const COST_SMOOTHING = 0.25

export class FrameBudgetScheduler {
  private readonly options: SchedulerOptions
  private queue = new Map<string, TerrainTask>()
  /** Smoothed measured cost per task class, keyed by the id prefix. */
  private measuredCostMs = new Map<string, number>()
  /** Smoothed cost per uploaded byte, for task classes that declare a size. */
  private measuredCostMsPerByte = new Map<string, number>()
  private readonly qualityScale = 1
  private averageFrameMs = 16.67
  private remainingCpuMs = 0
  private remainingUploadBytes = 0
  private remainingSwaps = 0
  private terrainTimeMs = 0
  private uploadBytes = 0
  private swaps = 0
  private tasksRun = 0
  private violations = 0

  constructor(options: SchedulerOptions) {
    this.options = options
  }

  beginFrame(frameMs: number, startupScale = 1): void {
    const target = this.options.targetFrameMs ?? 16.67
    this.averageFrameMs = lerp(this.averageFrameMs, frameMs, 0.04)
    const scale = clamp(startupScale, 1, 6)

    // Preserve a small progress floor under pressure. Otherwise a ready swap
    // whose estimate is larger than the reduced allowance can starve forever.
    const pressure = clamp((target * 1.35 - this.averageFrameMs) / target, 0.35, 1)
    this.remainingCpuMs = this.options.cpuTerrainMs * pressure * scale
    this.remainingUploadBytes = Math.floor(
      this.options.gpuUploadBytes * Math.max(0.35, this.qualityScale) * scale,
    )
    this.remainingSwaps = Math.max(
      1,
      Math.floor(this.options.sectionSwaps * this.qualityScale * scale),
    )
    this.terrainTimeMs = 0
    this.uploadBytes = 0
    this.swaps = 0
    this.tasksRun = 0
  }

  enqueue(task: TerrainTask): void {
    const previous = this.queue.get(task.id)
    if (!previous || task.priority >= previous.priority) this.queue.set(task.id, task)
  }

  runFrame(): void {
    if (this.queue.size === 0) return
    const tasks = [...this.queue.values()].sort((a, b) => b.priority - a.priority)

    for (const task of tasks) {
      const uploadBytes = task.uploadBytes ?? 0
      const swaps = task.swaps ?? 0
      const cpuMs = this.expectedCpuMs(task)
      const exceedsRemainingBudget =
        cpuMs > this.remainingCpuMs ||
        uploadBytes > this.remainingUploadBytes ||
        swaps > this.remainingSwaps
      // A task larger than an absolute per-frame cap can never become
      // eligible by waiting. Dense CSG sections can legitimately cross the
      // upload cap by a small amount, so admit exactly one such task on an
      // otherwise untouched frame and charge its full overage afterward.
      const individuallyOversized =
        cpuMs > this.options.cpuTerrainMs ||
        uploadBytes > this.options.gpuUploadBytes ||
        swaps > this.options.sectionSwaps
      const allowOversizedProgress =
        exceedsRemainingBudget && individuallyOversized && this.tasksRun === 0
      // Nothing has run yet this frame, so whatever is at the head of the queue
      // runs even though the allowance says no. Without this the queue can stop
      // permanently: `beginFrame` shrinks the allowance while frames are slow,
      // and once the smallest real task costs more than the shrunken allowance,
      // every frame declines it, no work happens, frames stay slow and the
      // allowance never recovers. That was survivable only while the declared
      // costs were far below the truth -- the swap that claimed 0.42 ms always
      // fitted, whatever it actually did -- and measuring them for real is
      // exactly what turned the deadlock into something reachable.
      const allowFirstTaskProgress =
        exceedsRemainingBudget && !individuallyOversized && this.tasksRun === 0
      if (
        exceedsRemainingBudget &&
        !allowOversizedProgress &&
        !allowFirstTaskProgress
      ) {
        continue
      }

      this.queue.delete(task.id)
      const start = performance.now()
      task.run()
      const elapsed = performance.now() - start
      this.recordCost(task, elapsed)
      this.terrainTimeMs += elapsed
      this.remainingCpuMs -= elapsed
      this.remainingUploadBytes -= uploadBytes
      this.remainingSwaps -= swaps
      this.uploadBytes += uploadBytes
      this.swaps += swaps
      this.tasksRun += 1

      if (elapsed > Math.max(4, task.estimatedCpuMs * 3)) this.violations += 1
      if (allowOversizedProgress) break
      if (this.remainingCpuMs <= 0) break
    }
  }

  /**
   * What this task is expected to cost, preferring measurement over the
   * caller's guess.
   *
   * The declared `estimatedCpuMs` values are constants written next to each
   * call site, and they drift: a section swap declared 0.42 ms was really
   * costing tens of milliseconds, so the budget admitted it every frame, blew
   * through the allowance and only found out afterwards. Once a class of task
   * has been timed, that measurement is what the admission test uses, which is
   * what lets an expensive task wait for a frame with room for it instead of
   * taking one that has not got it.
   *
   * Where a task declares `uploadBytes`, the rate is learned per byte rather
   * than per task. Section swaps span two orders of magnitude -- the finest
   * level carries 15,000 triangles and the coarsest 72 -- so one average over
   * all of them is wrong in both directions at once: it lets an expensive near
   * section through on a frame with no room for it, and it makes a whole queue
   * of trivial distant ones wait as though each were expensive. Charging by
   * size lets a frame take one of the former or dozens of the latter.
   */
  private expectedCpuMs(task: TerrainTask): number {
    const uploadBytes = task.uploadBytes ?? 0
    if (uploadBytes > 0) {
      const rate = this.measuredCostMsPerByte.get(costClassOf(task))
      if (rate !== undefined) return uploadBytes * rate
    }
    const measured = this.measuredCostMs.get(costClassOf(task))
    return measured ?? task.estimatedCpuMs
  }

  private recordCost(task: TerrainTask, elapsed: number): void {
    const key = costClassOf(task)
    const previous = this.measuredCostMs.get(key)
    this.measuredCostMs.set(
      key,
      previous === undefined
        ? elapsed
        : previous + (elapsed - previous) * COST_SMOOTHING,
    )
    const uploadBytes = task.uploadBytes ?? 0
    if (uploadBytes <= 0) return
    const rate = elapsed / uploadBytes
    const previousRate = this.measuredCostMsPerByte.get(key)
    this.measuredCostMsPerByte.set(
      key,
      previousRate === undefined
        ? rate
        : previousRate + (rate - previousRate) * COST_SMOOTHING,
    )
  }

  clear(prefix?: string): void {
    if (!prefix) {
      this.queue.clear()
      return
    }
    for (const id of this.queue.keys()) {
      if (id.startsWith(prefix)) this.queue.delete(id)
    }
  }

  get terrainMainThreadMs(): number {
    return this.terrainTimeMs
  }

  get uploadedBytesThisFrame(): number {
    return this.uploadBytes
  }

  get swapsThisFrame(): number {
    return this.swaps
  }

  get pendingTaskCount(): number {
    return this.queue.size
  }

  /** Smoothed measured cost per task class, for metrics and tests. */
  measuredCosts(): ReadonlyMap<string, number> {
    return this.measuredCostMs
  }

  snapshot(): FrameBudgetSnapshot {
    return {
      cpuTerrainMs: this.options.cpuTerrainMs,
      gpuUploadBytes: this.options.gpuUploadBytes,
      sectionSwaps: this.options.sectionSwaps,
      remainingCpuMs: this.remainingCpuMs,
      remainingGpuUploadBytes: this.remainingUploadBytes,
      remainingSectionSwaps: this.remainingSwaps,
      violations: this.violations,
      qualityScale: this.qualityScale,
      averageFrameMs: this.averageFrameMs,
    }
  }
}

/**
 * Tasks of the same class do comparable work, so they share a cost history.
 * Ids are `<class>:<subject>` -- `swap:12:7`, `evict:3:-1`, `dispose:geometry`
 * -- and the class alone is the useful grouping: every swap uploads a section,
 * while an eviction and an autosave have nothing to say about each other.
 */
function costClassOf(task: TerrainTask): string {
  const separator = task.id.indexOf(':')
  return separator === -1 ? task.id : task.id.slice(0, separator)
}
