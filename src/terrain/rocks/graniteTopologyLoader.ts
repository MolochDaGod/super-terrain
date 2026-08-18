import {
  extractGraniteTopology,
  hasGraniteTopology,
  primeGraniteTopology,
} from './generateGraniteRock'
import {
  graniteSourceSeed,
  type GraniteRockParameters,
  type GraniteSourceSeed,
  type GraniteTopologyDetail,
} from './types'
import type { GraniteTopologyResponse } from '../workers/graniteTopology.worker'

const inFlight = new Map<string, Promise<void>>()

/**
 * Fills the topology cache for one recipe so the next synchronous
 * `generateGraniteRock` is a cache hit.
 *
 * The finest tier dual-contours a 72³ grid, which takes seconds, so the work
 * runs in a worker whenever one is available and falls back to extracting in
 * place (tests, non-DOM hosts) otherwise.
 */
export function ensureGraniteTopology(
  parameters: GraniteRockParameters,
): Promise<void> {
  const sourceSeed = graniteSourceSeed(parameters.seed)
  const cells = parameters.topologyDetail
  if (hasGraniteTopology(sourceSeed, cells)) return Promise.resolve()

  const key = `${sourceSeed}:${cells}`
  let pending = inFlight.get(key)
  if (!pending) {
    pending = extractInWorker(sourceSeed, cells).finally(() => {
      inFlight.delete(key)
    })
    inFlight.set(key, pending)
  }
  return pending
}

function extractInWorker(
  sourceSeed: GraniteSourceSeed,
  cells: GraniteTopologyDetail,
): Promise<void> {
  if (typeof Worker === 'undefined') {
    primeGraniteTopology(sourceSeed, cells, extractGraniteTopology(sourceSeed, cells))
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/graniteTopology.worker.ts', import.meta.url),
      { type: 'module', name: 'granite-topology' },
    )
    worker.onmessage = (event: MessageEvent<GraniteTopologyResponse>) => {
      worker.terminate()
      if (event.data.error) {
        reject(new Error(event.data.error))
        return
      }
      primeGraniteTopology(sourceSeed, cells, {
        positions: event.data.positions,
        normals: event.data.normals,
        indices: event.data.indices,
      })
      resolve()
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'Granite topology worker failed'))
    }
    worker.postMessage({ sourceSeed, cells })
  })
}
