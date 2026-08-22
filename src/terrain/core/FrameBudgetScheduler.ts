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

export class FrameBudgetScheduler {
  private readonly options: SchedulerOptions
  private queue = new Map<string, TerrainTask>()
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
      const exceedsRemainingBudget =
        task.estimatedCpuMs > this.remainingCpuMs ||
        uploadBytes > this.remainingUploadBytes ||
        swaps > this.remainingSwaps
      // A task larger than an absolute per-frame cap can never become
      // eligible by waiting. Dense CSG sections can legitimately cross the
      // upload cap by a small amount, so admit exactly one such task on an
      // otherwise untouched frame and charge its full overage afterward.
      const individuallyOversized =
        task.estimatedCpuMs > this.options.cpuTerrainMs ||
        uploadBytes > this.options.gpuUploadBytes ||
        swaps > this.options.sectionSwaps
      const allowOversizedProgress =
        exceedsRemainingBudget && individuallyOversized && this.tasksRun === 0
      if (exceedsRemainingBudget && !allowOversizedProgress) {
        continue
      }

      this.queue.delete(task.id)
      const start = performance.now()
      task.run()
      const elapsed = performance.now() - start
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
