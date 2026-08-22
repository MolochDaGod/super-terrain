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

/**
 * Extent the demo's water mesh used to be built over, in world metres.
 *
 * The editor now derives the meshed extent from the painted water mask instead,
 * so this survives only as the fixed region the surface builder is tested
 * against — a stable rectangle is what makes that test about the mesher rather
 * than about whatever happens to be flooded.
 */
export const WATER_REGION: AABB = {
  min: { x: 0, y: WATER_LEVEL, z: -500 },
  max: { x: 420, y: WATER_LEVEL, z: 720 },
}
