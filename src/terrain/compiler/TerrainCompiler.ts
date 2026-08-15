import type { TerrainConfig } from '../config'
import type { CompiledSection, SectionKey } from '../core/types'
import type { TerrainModifier } from '../modifiers/types'
import {
  TerrainWorkerPool,
  type TerrainWorkerPoolStats,
} from '../workers/TerrainWorkerPool'

export interface TerrainCompilerResult {
  jobId: number
  key: SectionKey
  revision: number
  compiled?: CompiledSection
  error?: string
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
        })
      }
    }
  }

  queue(
    key: SectionKey,
    revision: number,
    priority: number,
    modifiers: TerrainModifier[],
  ): number {
    return this.pool.submit(key, revision, priority, modifiers)
  }

  cancel(key: SectionKey, beforeRevision?: number): void {
    this.pool.cancelSection(key, beforeRevision)
  }

  stats(): TerrainWorkerPoolStats {
    return this.pool.stats()
  }

  dispose(): void {
    this.pool.dispose()
  }
}
