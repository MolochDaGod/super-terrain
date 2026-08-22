/// <reference lib="webworker" />

import { generateFarFieldMesh } from '../rendering/FarFieldMesh'
import { setWorldProfile, type WorldProfile } from '../compiler/heightField'

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = (event: MessageEvent<{ worldSize: number; seed: number; worldProfile?: WorldProfile }>) => {
  // The horizon has to be built from the same landform model as the sections
  // it meets, or a flat world grows mountains beyond its render radius.
  setWorldProfile(event.data.worldProfile ?? 'natural')
  const mesh = generateFarFieldMesh(event.data.worldSize, event.data.seed)
  workerScope.postMessage(mesh, [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.colors.buffer,
    mesh.fullColors.buffer,
    mesh.indices.buffer,
  ])
}
