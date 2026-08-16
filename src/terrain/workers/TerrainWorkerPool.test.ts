import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TERRAIN_CONFIG } from '../config'
import type { TerrainWorkerRequest, TerrainWorkerResponse } from './protocol'
import { TerrainWorkerPool } from './TerrainWorkerPool'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<TerrainWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request?: TerrainWorkerRequest

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(request: TerrainWorkerRequest): void {
    this.request = request
  }

  terminate(): void {}

  respond(response: TerrainWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<TerrainWorkerResponse>)
  }
}

describe('terrain worker pool revisions', () => {
  const OriginalWorker = globalThis.Worker

  beforeEach(() => {
    FakeWorker.instances = []
    globalThis.Worker = FakeWorker as unknown as typeof Worker
  })

  afterEach(() => {
    globalThis.Worker = OriginalWorker
  })

  it('cancels redundant queued revisions for the same section', () => {
    const pool = new TerrainWorkerPool(1, DEFAULT_TERRAIN_CONFIG)
    pool.submit({ x: 0, z: 0 }, 1, 1, [])
    pool.submit({ x: 0, z: 0 }, 2, 1, [])
    pool.submit({ x: 0, z: 0 }, 3, 1, [])
    expect(pool.stats()).toMatchObject({ active: 1, queued: 1, cancelled: 1 })
    pool.dispose()
  })

  it('drops an in-flight result after a newer revision is requested', () => {
    const pool = new TerrainWorkerPool(1, DEFAULT_TERRAIN_CONFIG)
    let results = 0
    pool.onResult = () => {
      results += 1
    }
    const jobId = pool.submit({ x: 0, z: 0 }, 1, 1, [])
    pool.submit({ x: 0, z: 0 }, 2, 1, [])
    FakeWorker.instances[0].respond({
      kind: 'compile-success',
      jobId,
      key: { x: 0, z: 0 },
      revision: 1,
      compiled: {
        key: { x: 0, z: 0 },
        sourceRevision: 1,
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
        lods: [],
        cpuBytes: 0,
        metadata: {
          compileMs: 1,
          vertexCount: 0,
          triangleCount: 0,
          density: 0,
          hasArbitraryTopology: false,
          validationWarnings: 0,
        },
      },
    })
    expect(pool.stats().stale).toBe(1)
    expect(results).toBe(0)
    expect(FakeWorker.instances[0].request?.revision).toBe(2)
    pool.dispose()
  })
})
