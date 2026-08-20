import { WATER_LEVEL } from '../compiler/climate'
import type { AABB } from '../core/types'

/**
 * The flooded basin in front of the massif.
 *
 * The procedural drainage field carries no flow through this basin — it is a
 * closed alpine floor, not a catchment — so the braided channels the reference
 * frame has cannot be read out of `sampleHeightField().flow`. They are made the
 * way the real ones are instead: put a water plane at a level a couple of
 * metres into the floor's own roughness, and the floor's existing bumps become
 * bars, islands and channels on their own. Nothing needs to be carved, and the
 * shoreline is exactly where the terrain crosses the level, whatever edits are
 * made to it later.
 */
export { WATER_LEVEL }

/** Extent the water mesh is built over, in world metres. */
export const WATER_REGION: AABB = {
  min: { x: -140, y: WATER_LEVEL, z: -280 },
  max: { x: 500, y: WATER_LEVEL, z: 420 },
}
