/**
 * World-scale climate constants shared by the section compiler and the
 * far-field proxy, so the two can never disagree about where a material band
 * starts. They are constants rather than config because the compiler runs in
 * workers that are handed sections, not a `TerrainConfig`.
 */

/**
 * The altitude the highest ground in this world actually reaches, in metres.
 *
 * Every band below is a fraction of this rather than an absolute altitude, and
 * that is the whole point of the constant. The previous model placed the snow
 * line at 1400 m and the vegetation limit at 268-412 m, numbers borrowed from a
 * real temperate range. This world's summits reach 391 m and its median ground
 * sits at 1 m, so the snow line could never fire anywhere at all and the
 * vegetation limit sat above the 99th percentile of the terrain — the entire
 * massif, valley floor to crest, fell inside a single band. That is why a
 * mountain here had no mountain-ness to it: not because any one band was wrong,
 * but because there was only ever one.
 *
 * Zonation is what makes relief legible. The eye reads height from the *order*
 * of the bands it crosses going up — closed vegetation, then a treeline, then
 * open turf, then fellfield and talus, then shattered rock and snow — and that
 * order reads correctly whether it is spread over three thousand metres or
 * three hundred. Compressing the sequence into the relief that exists is
 * therefore not a cheat; it is the same thing a scale model does.
 */
export const SUMMIT_ALTITUDE = 391

/**
 * The zone boundaries, as fractions of the summit.
 *
 * Proportions taken from temperate alpine zonation, where the treeline sits a
 * little above half the relief and the ground is continuously vegetated for
 * roughly the first third. Keeping them as fractions means a world generated
 * with a different amplitude gets the same mountain, not a bare one or a green
 * one.
 */
/** Below this, vegetation is limited by moisture and slope alone. */
export const MONTANE_TOP = 0.3
/** Trees give out here; above it, only turf, dwarf shrub and rock. */
export const TREE_LINE = 0.54
/** Continuous turf gives out here, breaking into fellfield cushions. */
export const ALPINE_TURF_TOP = 0.74
/** Above this even fellfield fails and the ground is frost-shattered rock. */
export const FELLFIELD_TOP = 0.88

/** Altitude in metres where the closed montane zone ends. */
export const MONTANE_ALTITUDE = MONTANE_TOP * SUMMIT_ALTITUDE
/** Altitude in metres of the treeline. */
export const TREE_LINE_ALTITUDE = TREE_LINE * SUMMIT_ALTITUDE
/** Altitude in metres where continuous turf gives out. */
export const ALPINE_TURF_ALTITUDE = ALPINE_TURF_TOP * SUMMIT_ALTITUDE
/** Altitude in metres where fellfield gives way to bare shattered rock. */
export const FELLFIELD_ALTITUDE = FELLFIELD_TOP * SUMMIT_ALTITUDE

/**
 * Altitude in metres where permanent snow begins, and the band it fades in
 * over.
 *
 * A snow line is the single strongest scale cue a range has: it tells the eye
 * how high the summits are by how much of them is white, and a range with none
 * reads as a hill no matter how much relief it has.
 *
 * Placed at three fifths of the summit rather than just under the fellfield
 * limit, and given a band half as wide again. The first attempt put it at 0.85,
 * which is defensible on paper and produced almost nothing on screen — only
 * about two thousandths of this world's ground stands above that, so the whole
 * of the snow was a few white pixels on one crest. The altitude distribution
 * here is heavily bottom-weighted (median 1 m, 99th percentile 245 m, summit
 * 391 m), so a line placed by proportion of *relief* lands far higher up the
 * curve than the same proportion of *ground*. Three fifths puts snow on the
 * upper massif and its ridges and none on the foothills, which is the picture
 * the number is for.
 *
 * The slope term in the classifier keeps it honest from there: snow does not
 * lie on a face steep enough to shed it, so the cap breaks into couloirs and
 * ledges down the flanks instead of painting the summit as a white cone.
 */
export const SNOW_LINE = 0.6 * SUMMIT_ALTITUDE
export const SNOW_LINE_BAND = 74

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
