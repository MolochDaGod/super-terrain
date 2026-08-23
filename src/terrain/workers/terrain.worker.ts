/// <reference lib="webworker" />

import { compileTerrainSection } from '../compiler/compileSection'
import type {
  TerrainWorkerRequest,
  TerrainWorkerResponse,
} from './protocol'
import { compiledTransferables } from './protocol'

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = (event: MessageEvent<TerrainWorkerRequest>) => {
  const request = event.data
  workerScope.postMessage({
    kind: 'compile-started',
    jobId: request.jobId,
    key: request.key,
    revision: request.revision,
  } satisfies TerrainWorkerResponse)
  try {
    const compiled = compileTerrainSection(request)
    const response: TerrainWorkerResponse = {
      kind: 'compile-success',
      jobId: request.jobId,
      key: request.key,
      revision: request.revision,
      compiled,
    }
    workerScope.postMessage(response, compiledTransferables(compiled))
  } catch (error) {
    const response: TerrainWorkerResponse = {
      kind: 'compile-failure',
      jobId: request.jobId,
      key: request.key,
      revision: request.revision,
      error: error instanceof Error ? error.message : String(error),
    }
    workerScope.postMessage(response)
  }
}
