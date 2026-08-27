/// <reference lib="webworker" />

import type { TreeSpecies } from '../generator/types'
import {
  bakeBarkTextureData,
  bakeLeafCardTextureData,
  bakeProceduralTreeTextureData,
  type LeafSprayTextureData,
  type ProceduralTreeTextureData,
  type TreeTextureResolution,
} from './proceduralTreeTextures'

interface BakeRequestBase {
  /** Correlates a reply with its request; one worker serves many jobs. */
  id: number
  species: TreeSpecies
  seed: number
  resolution: TreeTextureResolution
}

/** A whole material set in one call. Kept for the no-pool fallback path. */
export interface ProceduralTreeTextureBakeRequest extends BakeRequestBase {
  kind?: 'set'
}

export interface BarkBakeRequest extends BakeRequestBase {
  kind: 'bark'
}

export interface LeafCardBakeRequest extends BakeRequestBase {
  kind: 'leaf'
  variant: number
}

export type TreeTextureBakeRequest =
  | ProceduralTreeTextureBakeRequest
  | BarkBakeRequest
  | LeafCardBakeRequest

export type ProceduralTreeTextureBakeReply =
  | { kind: 'complete'; id: number; data: ProceduralTreeTextureData }
  | { kind: 'bark'; id: number; data: ProceduralTreeTextureData['bark'] }
  | { kind: 'leaf'; id: number; variant: number; data: LeafSprayTextureData }
  | { kind: 'error'; id: number; error: string }

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = (event: MessageEvent<TreeTextureBakeRequest>) => {
  const request = event.data
  try {
    const { reply, transfer } = bake(request)
    workerScope.postMessage(reply, transfer)
  } catch (error) {
    const reply: ProceduralTreeTextureBakeReply = {
      kind: 'error',
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    }
    workerScope.postMessage(reply)
  }
}

function bake(request: TreeTextureBakeRequest): {
  reply: ProceduralTreeTextureBakeReply
  transfer: ArrayBuffer[]
} {
  const { id, species, seed, resolution } = request
  if (request.kind === 'bark') {
    const data = bakeBarkTextureData(species, seed, resolution)
    return {
      reply: { kind: 'bark', id, data },
      transfer: [data.albedo.buffer, data.normal.buffer, data.roughness.buffer] as ArrayBuffer[],
    }
  }
  if (request.kind === 'leaf') {
    const data = bakeLeafCardTextureData(species, seed, request.variant, resolution)
    return {
      reply: { kind: 'leaf', id, variant: request.variant, data },
      transfer: leafCardTransferables(data),
    }
  }
  const data = bakeProceduralTreeTextureData(species, seed, resolution)
  return {
    reply: { kind: 'complete', id, data },
    transfer: textureDataTransferables(data),
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
    ...data.leafCards.flatMap(leafCardTransferables),
  ] as ArrayBuffer[]
}

function leafCardTransferables(card: LeafSprayTextureData): ArrayBuffer[] {
  return [
    card.albedo.buffer,
    card.normal.buffer,
    card.roughness.buffer,
    // Level 0 of every chain aliases the map above it, so transferring it
    // twice would detach a buffer this message still needs.
    ...card.mipmaps.albedo.slice(1).map((level) => level.data.buffer),
    ...card.mipmaps.normal.slice(1).map((level) => level.data.buffer),
    ...card.mipmaps.roughness.slice(1).map((level) => level.data.buffer),
  ] as ArrayBuffer[]
}
