import type { TreeWorkerResponse } from './tree.worker'
import { compileProceduralTree } from './generator/compileTree'
import {
  DEFAULT_TREE_ENVIRONMENT,
  type ProceduralTreeAsset,
  type TreeEnvironment,
  type TreeParameters,
} from './generator/types'

export interface TreeGenerationOptions {
  signal?: AbortSignal
  onProgress?: (message: string, amount: number) => void
}

export function generateTreeAsset(
  parameters: TreeParameters,
  environment: TreeEnvironment = DEFAULT_TREE_ENVIRONMENT,
  options: TreeGenerationOptions = {},
): Promise<ProceduralTreeAsset> {
  if (typeof Worker === 'undefined') {
    if (options.signal?.aborted) return Promise.reject(abortError())
    return Promise.resolve(
      compileProceduralTree(parameters, environment, options.onProgress),
    )
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./tree.worker.ts', import.meta.url), {
      type: 'module',
      name: 'procedural-tree-compiler',
    })
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      worker.terminate()
      options.signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(abortError()))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (event: MessageEvent<TreeWorkerResponse>) => {
      const response = event.data
      if (response.kind === 'progress') {
        options.onProgress?.(response.message, response.amount)
        return
      }
      if (response.kind === 'error') {
        finish(() => reject(new Error(response.error)))
        return
      }
      finish(() => resolve(response.asset))
    }
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || 'Tree compiler worker failed')))
    }
    worker.postMessage({ parameters, environment })
  })
}

function abortError(): DOMException {
  return new DOMException('Tree generation was cancelled', 'AbortError')
}
