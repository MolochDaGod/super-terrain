/// <reference lib="webworker" />

import {
  compileProceduralTree,
  treeAssetTransferables,
} from './generator/compileTree'
import { optimizeTreeMeshSubmission } from './generator/optimizeTreeMesh'
import type {
  ProceduralTreeAsset,
  TreeEnvironment,
  TreeParameters,
} from './generator/types'

export interface TreeWorkerRequest {
  parameters: TreeParameters
  environment: TreeEnvironment
}

export type TreeWorkerResponse =
  | { kind: 'progress'; message: string; amount: number }
  | { kind: 'complete'; asset: ProceduralTreeAsset }
  | { kind: 'error'; error: string }

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = async (event: MessageEvent<TreeWorkerRequest>) => {
  try {
    const asset = compileProceduralTree(
      event.data.parameters,
      event.data.environment,
      (message, amount) => {
        const response: TreeWorkerResponse = { kind: 'progress', message, amount }
        workerScope.postMessage(response)
      },
    )
    await optimizeTreeMeshSubmission(asset)
    const response: TreeWorkerResponse = { kind: 'complete', asset }
    workerScope.postMessage(response, treeAssetTransferables(asset))
  } catch (error) {
    const response: TreeWorkerResponse = {
      kind: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
    workerScope.postMessage(response)
  }
}
