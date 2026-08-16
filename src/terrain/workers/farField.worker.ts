/// <reference lib="webworker" />

import { generateFarFieldMesh } from '../rendering/FarFieldMesh'

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = (event: MessageEvent<{ worldSize: number; seed: number }>) => {
  const mesh = generateFarFieldMesh(event.data.worldSize, event.data.seed)
  workerScope.postMessage(mesh, [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.colors.buffer,
    mesh.fullColors.buffer,
    mesh.indices.buffer,
  ])
}
