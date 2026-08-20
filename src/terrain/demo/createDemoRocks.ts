import { SHARD_CENTER } from './createHeroShard'
import {
  DEFAULT_GRANITE_ROCK_PARAMETERS,
  type GraniteRockParameters,
} from '../rocks/types'
import type { Vec3Like } from '../core/types'

/**
 * The glacial erratics scattered across the basin below the shard.
 *
 * They exist for scale and for the near field. A valley floor with nothing on
 * it gives the eye no way to judge how large the landform behind it is, and the
 * first thirty metres in front of the camera is where a frame is won or lost —
 * it is the only place where metre-scale detail is resolvable at all.
 *
 * These are ordinary scene rocks, planted through the same path the editor's
 * Granite Rock Lab uses, not a special case in the renderer.
 */
export interface DemoRockPlacement {
  parameters: GraniteRockParameters
  /** Where on the terrain surface the rock is planted; y is filled in later. */
  point: Vec3Like
}

const PLACEMENTS: {
  offset: [number, number]
  scale: number
  seed: number
  lichen: number
  moss: number
}[] = [
  { offset: [-165, 128], scale: 13, seed: 2, lichen: 0.3, moss: 0.22 },
  { offset: [-120, 96], scale: 7.5, seed: 5, lichen: 0.24, moss: 0.12 },
  { offset: [-198, 62], scale: 9.5, seed: 7, lichen: 0.34, moss: 0.28 },
  { offset: [-92, 150], scale: 5.5, seed: 3, lichen: 0.18, moss: 0.1 },
  { offset: [-206, 44], scale: 16, seed: 6, lichen: 0.38, moss: 0.3 },
  { offset: [-58, 74], scale: 4.5, seed: 4, lichen: 0.2, moss: 0.08 },
  { offset: [-148, 178], scale: 6.5, seed: 1, lichen: 0.26, moss: 0.16 },
]

export function createDemoGraniteRocks(): DemoRockPlacement[] {
  return PLACEMENTS.map((placement) => ({
    parameters: {
      ...DEFAULT_GRANITE_ROCK_PARAMETERS,
      seed: placement.seed,
      surfaceSeed: placement.seed + 2,
      placementScale: placement.scale,
      lichen: placement.lichen,
      moss: placement.moss,
      wetness: 0.14,
      detail: 3,
    },
    point: {
      x: SHARD_CENTER.x + placement.offset[0],
      y: 0,
      z: SHARD_CENTER.z + placement.offset[1],
    },
  }))
}
