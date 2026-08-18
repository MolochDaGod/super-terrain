/// <reference lib="webworker" />

import { extractGraniteTopology } from '../rocks/generateGraniteRock'
import type {
  GraniteSourceSeed,
  GraniteTopologyDetail,
} from '../rocks/types'

export interface GraniteTopologyRequest {
  sourceSeed: GraniteSourceSeed
  cells: GraniteTopologyDetail
}

export interface GraniteTopologyResponse {
  positions: Float64Array
  normals: Float64Array
  indices: Uint32Array
  error?: string
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = (event: MessageEvent<GraniteTopologyRequest>) => {
  try {
    const surface = extractGraniteTopology(
      event.data.sourceSeed,
      event.data.cells,
    )
    workerScope.postMessage(surface, [
      surface.positions.buffer,
      surface.normals.buffer,
      surface.indices.buffer,
    ])
  } catch (error) {
    workerScope.postMessage({
      positions: new Float64Array(0),
      normals: new Float64Array(0),
      indices: new Uint32Array(0),
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
