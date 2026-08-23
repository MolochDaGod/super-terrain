import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TERRAIN_CONFIG } from '../config'
import type { TerrainWorkerRequest, TerrainWorkerResponse } from './protocol'
import { TerrainWorkerPool } from './TerrainWorkerPool'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<TerrainWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request?: TerrainWorkerRequest
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(request: TerrainWorkerRequest): void {
    this.request = request
  }

  terminate(): void {
    this.terminated = true
  }

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
    // Depth one: this is about what the queue does, and a pipeline deep enough
    // to swallow all three submissions would leave nothing queued to coalesce.
    const pool = new TerrainWorkerPool(1, DEFAULT_TERRAIN_CONFIG, 1)
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

  it('preempts departed active work and immediately dispatches the next job', () => {
    const pool = new TerrainWorkerPool(1, DEFAULT_TERRAIN_CONFIG, 1)
    const cancelledJob = pool.submit({ x: 0, z: 0 }, 1, 2, [], [3, 4])
    const nextJob = pool.submit({ x: 8, z: 0 }, 1, 9, [], [1, 2, 3, 4])
    const firstWorker = FakeWorker.instances[0]

    expect(firstWorker.request).toMatchObject({
      jobId: cancelledJob,
      levels: [3, 4],
    })
    expect(pool.cancelSection({ x: 0, z: 0 }, 1)).toEqual({
      queued: 0,
      active: 1,
    })
    expect(firstWorker.terminated).toBe(true)
    expect(FakeWorker.instances).toHaveLength(2)
    expect(FakeWorker.instances[1].request).toMatchObject({
      jobId: nextJob,
      levels: [1, 2, 3, 4],
    })
    expect(pool.stats()).toMatchObject({ active: 1, queued: 0, cancelled: 1 })
    pool.dispose()
  })

  it('reprioritizes queued work before a slot becomes free', () => {
    const pool = new TerrainWorkerPool(1, DEFAULT_TERRAIN_CONFIG, 1)
    const active = pool.submit({ x: 0, z: 0 }, 1, 10, [])
    const low = pool.submit({ x: 1, z: 0 }, 1, 1, [])
    const raised = pool.submit({ x: 2, z: 0 }, 1, 2, [])
    expect(pool.reprioritizeSection({ x: 1, z: 0 }, 1, 20)).toBe(true)

    FakeWorker.instances[0].respond(successResponse(active, { x: 0, z: 0 }))
    expect(FakeWorker.instances[0].request?.jobId).toBe(low)
    expect(FakeWorker.instances[0].request?.jobId).not.toBe(raised)
    pool.dispose()
  })

  it('keeps a worker supplied so it never waits on the main thread', () => {
    const pool = new TerrainWorkerPool(2, DEFAULT_TERRAIN_CONFIG, 3)
    for (let index = 0; index < 6; index += 1) {
      pool.submit({ x: index, z: 0 }, 1, 10 - index, [])
    }
    // Dispatch is breadth first, so both workers are supplied before either is
    // given a second job, and nothing is left waiting in the queue.
    expect(pool.stats()).toMatchObject({ active: 6, queued: 0 })
    expect(FakeWorker.instances).toHaveLength(2)
    pool.dispose()
  })

  it('returns a restarted slot\'s untouched work to the queue', () => {
    const pool = new TerrainWorkerPool(1, DEFAULT_TERRAIN_CONFIG, 3)
    const doomed = pool.submit({ x: 0, z: 0 }, 1, 10, [])
    const survivor = pool.submit({ x: 1, z: 0 }, 1, 9, [])
    expect(pool.stats()).toMatchObject({ active: 2, queued: 0 })

    // Cancelling in-flight work has to terminate the worker, which takes the
    // pipelined job beside it down too. That one is still wanted.
    expect(pool.cancelSection({ x: 0, z: 0 }, 1)).toEqual({ queued: 0, active: 1 })
    expect(FakeWorker.instances[0].terminated).toBe(true)
    expect(FakeWorker.instances[1].request).toMatchObject({ jobId: survivor })
    expect(pool.stats()).toMatchObject({ active: 1, queued: 0, cancelled: 1 })
    expect(doomed).not.toBe(survivor)
    pool.dispose()
  })

  it('never starts a queued revision that has already been superseded', () => {
    const pool = new TerrainWorkerPool(1, DEFAULT_TERRAIN_CONFIG, 1)
    const first = pool.submit({ x: 0, z: 0 }, 1, 10, [])
    // Queued behind the active job, then overtaken while it waits.
    pool.submit({ x: 5, z: 0 }, 1, 5, [])
    pool.submit({ x: 5, z: 0 }, 2, 5, [])
    FakeWorker.instances[0].respond(successResponse(first, { x: 0, z: 0 }))
    expect(FakeWorker.instances[0].request).toMatchObject({ revision: 2 })
    pool.dispose()
  })
})

function successResponse(
  jobId: number,
  key: { x: number; z: number },
): TerrainWorkerResponse {
  return {
    kind: 'compile-success',
    jobId,
    key,
    revision: 1,
    compiled: {
      key,
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
  }
}
