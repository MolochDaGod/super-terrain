/// <reference lib="webworker" />

import type { TreeSpecies } from '../generator/types'
import {
  bakeProceduralTreeTextureData,
  type ProceduralTreeTextureData,
  type TreeTextureResolution,
} from './proceduralTreeTextures'

export interface ProceduralTreeTextureBakeRequest {
  species: TreeSpecies
  seed: number
  resolution: TreeTextureResolution
}

export type ProceduralTreeTextureBakeReply =
  | { kind: 'complete'; data: ProceduralTreeTextureData }
  | { kind: 'error'; error: string }

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = (
  event: MessageEvent<ProceduralTreeTextureBakeRequest>,
) => {
  try {
    const data = bakeProceduralTreeTextureData(
      event.data.species,
      event.data.seed,
      event.data.resolution,
    )
    const reply: ProceduralTreeTextureBakeReply = { kind: 'complete', data }
    workerScope.postMessage(reply, textureDataTransferables(data))
  } catch (error) {
    const reply: ProceduralTreeTextureBakeReply = {
      kind: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
    workerScope.postMessage(reply)
  }
}

/** Transfer every bake buffer once rather than cloning tens of megabytes. */
export function textureDataTransferables(
  data: ProceduralTreeTextureData,
): ArrayBuffer[] {
  return [
    data.bark.albedo.buffer,
    data.bark.normal.buffer,
    data.bark.roughness.buffer,
    ...data.leafCards.flatMap((card) => [
      card.albedo.buffer,
      card.normal.buffer,
      card.roughness.buffer,
      ...card.mipmaps.albedo.slice(1).map((level) => level.data.buffer),
      ...card.mipmaps.normal.slice(1).map((level) => level.data.buffer),
      ...card.mipmaps.roughness.slice(1).map((level) => level.data.buffer),
    ]),
  ] as ArrayBuffer[]
}
