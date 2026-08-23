import type { TerrainConfig } from '../config'
import type { CompiledSection, SectionKey } from '../core/types'
import type { TerrainSectionSourceSnapshot } from '../mesh/EditableMesh'
import type { TerrainModifier } from '../modifiers/types'
import {
  TerrainWorkerPool,
  type TerrainWorkerCancellation,
  type TerrainWorkerJobStatus,
  type TerrainWorkerPoolStats,
} from '../workers/TerrainWorkerPool'

export interface TerrainCompilerResult {
  jobId: number
  key: SectionKey
  revision: number
  compiled?: CompiledSection
  error?: string
  /** The pool dropped the job; the section is fine and should be requeued. */
  retryable?: boolean
}

export class TerrainCompiler {
  private readonly pool: TerrainWorkerPool
  onResult?: (result: TerrainCompilerResult) => void

  constructor(config: TerrainConfig) {
    this.pool = new TerrainWorkerPool(config.workerCount, config)
    this.pool.onResult = (result) => {
      if (result.ok) {
        this.onResult?.({
          jobId: result.jobId,
          key: result.compiled.key,
          revision: result.compiled.sourceRevision,
          compiled: result.compiled,
        })
      } else {
        this.onResult?.({
          jobId: result.jobId,
          key: result.key,
          revision: result.revision,
          error: result.error,
          retryable: result.retryable,
        })
      }
    }
  }

  queue(
    key: SectionKey,
    revision: number,
    priority: number,
    modifiers: TerrainModifier[],
    levels?: readonly number[],
    source?: TerrainSectionSourceSnapshot,
  ): number {
    return this.pool.submit(key, revision, priority, modifiers, levels, source)
  }

  cancel(
    key: SectionKey,
    beforeRevision?: number,
  ): TerrainWorkerCancellation {
    return this.pool.cancelSection(key, beforeRevision)
  }

  /** Rewrites the level set of a job that has not started yet. */
  retarget(
    key: SectionKey,
    revision: number,
    levels: readonly number[],
    priority: number,
  ): boolean {
    return this.pool.retargetQueued(key, revision, levels, priority)
  }

  reprioritize(key: SectionKey, revision: number, priority: number): boolean {
    return this.pool.reprioritizeSection(key, revision, priority)
  }

  stats(): TerrainWorkerPoolStats {
    return this.pool.stats()
  }

  jobStatus(jobId: number): TerrainWorkerJobStatus | undefined {
    return this.pool.jobStatus(jobId)
  }

  dispose(): void {
    this.pool.dispose()
  }
}
