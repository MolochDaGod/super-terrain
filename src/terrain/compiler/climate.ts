/**
 * World-scale climate constants shared by the section compiler and the
 * far-field proxy, so the two can never disagree about where a material band
 * starts. They are constants rather than config because the compiler runs in
 * workers that are handed sections, not a `TerrainConfig`.
 */

/**
 * Altitude in metres where permanent snow begins, and the band it fades in
 * over.
 *
 * The demo world is a temperate glacial valley in late summer at a latitude
 * where the snow line is above every summit it has: the hero frame's subject is
 * bare, stratified rock separated by mist, and a white cap on the far ridges
 * both flattens them into a postcard and steals the eye from the only thing in
 * the frame that is meant to be bright. Nothing here is high enough to reach
 * this, which is the point — the field is kept live rather than deleted so a
 * colder world is one number away.
 */
export const SNOW_LINE = 1_400
export const SNOW_LINE_BAND = 160

/**
 * The level standing water sits at in the basin, in metres.
 *
 * This is a climate constant rather than a property of the water mesh because
 * the ground has to know about it too: the valley floor beside a river is wet
 * meadow and gravel, not the dry pasture the altitude-and-drainage moisture
 * model gives ground that has no catchment above it. The basin here has none —
 * it is a closed floor, so `flow` is zero across the whole of it — and without
 * a water table the material system had no way to tell the strip beside the
 * water from a hillside four hundred metres up.
 */
export const WATER_LEVEL = 25
/** Metres above the water level over which the water table stops mattering. */
export const WATER_TABLE_REACH = 34
