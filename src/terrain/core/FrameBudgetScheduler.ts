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
  private qualityScale = 1
  private averageFrameMs = 16.67
  private remainingCpuMs = 0
  private remainingUploadBytes = 0
  private remainingSwaps = 0
  private terrainTimeMs = 0
  private uploadBytes = 0
  private swaps = 0
  private violations = 0
  private framesUnderBudget = 0

  constructor(options: SchedulerOptions) {
    this.options = options
  }

  beginFrame(frameMs: number): void {
    const target = this.options.targetFrameMs ?? 16.67
    this.averageFrameMs = lerp(this.averageFrameMs, frameMs, 0.04)

    if (this.averageFrameMs > target * 1.08) {
      this.qualityScale = clamp(this.qualityScale - 0.018, 0.48, 1)
      this.framesUnderBudget = 0
    } else if (this.averageFrameMs < target * 0.88) {
      this.framesUnderBudget += 1
      if (this.framesUnderBudget > 45) {
        this.qualityScale = clamp(this.qualityScale + 0.008, 0.48, 1)
      }
    } else {
      this.framesUnderBudget = 0
    }

    const pressure = clamp((target * 1.35 - this.averageFrameMs) / target, 0.2, 1)
    this.remainingCpuMs = this.options.cpuTerrainMs * pressure
    this.remainingUploadBytes = Math.floor(
      this.options.gpuUploadBytes * Math.max(0.35, this.qualityScale),
    )
    this.remainingSwaps = Math.max(
      1,
      Math.floor(this.options.sectionSwaps * this.qualityScale),
    )
    this.terrainTimeMs = 0
    this.uploadBytes = 0
    this.swaps = 0
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
      if (
        task.estimatedCpuMs > this.remainingCpuMs ||
        uploadBytes > this.remainingUploadBytes ||
        swaps > this.remainingSwaps
      ) {
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

      if (elapsed > Math.max(4, task.estimatedCpuMs * 3)) this.violations += 1
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
