import { treeSpeciesDefinition } from '../../generator/speciesCatalog'
import type { TreeSpecies } from '../../generator/types'
import { EXTENDED_LEAF_PROFILES } from './extendedProfiles'
import type { LeafPalette, LeafProfile } from './types'

/**
 * Foliage palettes.
 *
 * Each is three overlapping populations — deep shade, exposed sun, and the
 * tired minority — plus the colour dead tissue blends toward. Authoring them
 * as populations rather than as one hue is what gives a canopy tonal spread;
 * a single colour plus noise reads as one flat paint however good the outline
 * on top of it is.
 */
const TEMPERATE_GREEN: LeafPalette = {
  // Calibrated against measured canopy frames, not picked by eye. Folding the
  // old two-axis sun/shade mix into one interpolation moved the mid-variation
  // population — most of the crown — a seventh darker, which showed up as the
  // black-cutout fraction climbing back from five percent to seven.
  shade: [0.192, 0.284, 0.166],
  sun: [0.3, 0.436, 0.212],
  weathered: [0.298, 0.29, 0.142],
  necrosis: [0.3, 0.264, 0.15],
}
const CONIFER_GREEN: LeafPalette = {
  shade: [0.166, 0.238, 0.19],
  sun: [0.222, 0.322, 0.24],
  weathered: [0.238, 0.256, 0.19],
  necrosis: [0.27, 0.238, 0.15],
}
/** Tropical foliage is glossier, deeper and markedly less yellow. */
const TROPICAL_GREEN: LeafPalette = {
  shade: [0.13, 0.226, 0.135],
  sun: [0.226, 0.372, 0.192],
  weathered: [0.3, 0.286, 0.14],
  necrosis: [0.31, 0.26, 0.14],
}
/** Palm fronds are dusty, grey-green and sun-bleached at the tips. */
const PALM_GREEN: LeafPalette = {
  shade: [0.19, 0.27, 0.185],
  sun: [0.315, 0.4, 0.245],
  weathered: [0.4, 0.36, 0.2],
  necrosis: [0.4, 0.335, 0.18],
}
/** Fern fronds are the freshest green of anything here, and thin with it. */
const FERN_GREEN: LeafPalette = {
  shade: [0.15, 0.256, 0.135],
  sun: [0.256, 0.406, 0.176],
  weathered: [0.33, 0.3, 0.15],
  necrosis: [0.32, 0.27, 0.14],
}
/** Succulent rosettes: waxy, blue-grey, and barely green at all. */
const SUCCULENT_BLUE: LeafPalette = {
  shade: [0.216, 0.278, 0.238],
  sun: [0.315, 0.372, 0.312],
  weathered: [0.36, 0.33, 0.25],
  necrosis: [0.36, 0.3, 0.2],
}

/**
 * English oak: obovate, three to six irregular rounded lobe pairs, sinuses
 * cutting well toward the midrib, widest above the middle, near-sessile on a
 * short petiole with small basal auricles.
 */
const OAK_LOBED: LeafProfile = {
  family: 'broadleaf-lobed',
  aspect: 0.31,
  lobePairs: [3, 5],
  leaflets: [1, 1],
  baseRoughness: 0.52,
  translucency: 0.88,
  damage: 1,
  palette: TEMPERATE_GREEN,
  spray: {
    // Many small blades rather than a few large ones, and this is the whole
    // fix for "the leaves are enormous up close".
    //
    // The default composition puts about twenty-five blades on a card at a
    // quarter of its width each. A card is roughly three quarters of a metre
    // across in world space, so that is an eighteen-centimetre oak leaf — half
    // as big again as the largest real one, on a species whose blades are
    // usually nearer ten. At twenty metres nobody can tell; at two metres it
    // is the only thing anyone can see, because the eye knows exactly how big
    // an oak leaf is and the whole crown is calibrated against that.
    //
    // Coverage is what has to stay put. Leaf *area* is what occludes the sky,
    // what the shadow map integrates into floor dapple, and what the eye reads
    // as canopy density, so shrinking the blades without putting the area back
    // would thin every crown in the stand. Count × scale² is only the first
    // approximation — the blades go on the same shoots, so tripling their
    // number packs them tighter and the union comes in well under the sum.
    // These numbers were measured rather than derived: mean opaque coverage
    // across the eight atlas cells is 0.242 against the previous 0.247.
    //
    // So the canopy keeps its density and its dapple, and the *grain* of it
    // goes from twenty-five paddles to about eighty leaves. Not one extra
    // card, not one extra triangle, not one extra texel — it is a different
    // bake of the same eight atlas cells, which is the only reason this is
    // affordable at all.
    scale: 0.66,
    count: 3.4,
    // Real variety between atlas slots, not four reseeds of one size.
    variantScale: [0.86, 1.04, 1.18, 0.95],
    // Slivers, but short ones. The near-edge-on tail is what tells the eye a
    // twig has depth, and at the old blade size those slivers were
    // eighteen-centimetre ribbons a centimetre wide — the pale green streaks
    // that read as grass blades stuck in the canopy. At this size the same
    // fraction of edge-on blades is unremarkable.
    minimumSquash: 0.2,
    tiltExponent: 0.42,
    angleJitter: 0.3,
    curl: 1.4,
    sizeVariation: [0.62, 1.34],
    pigment: [0.86, 1.1],
    // Near-sessile: an English oak petiole is a few millimetres on a
    // hand-length blade.
    petiole: [0.05, 0.11],
    // Wider, so sixty-five blades distribute across the cell instead of
    // piling into a solid column along the axis.
    spreadScale: 1.12,
    // Thinner twigs. A shoot width authored against twenty-five big blades
    // reads as a branch once the blades are half the size.
    shootWidthScale: 0.72,
  },
}

/** Two-needle fascicles: long, stiff, blue-green, and barely translucent. */
const PINE_NEEDLE: LeafProfile = {
  family: 'needle-fascicle',
  aspect: 0.06,
  lobePairs: [0, 0],
  leaflets: [1, 1],
  baseRoughness: 0.47,
  translucency: 0.72,
  damage: 0.3,
  palette: CONIFER_GREEN,
}

/**
 * Picea abies: a deep, slightly blue green — not the grey-green of a Scots
 * pine.
 *
 * Sharing the pine palette put blue within a hundredth of red, which is a
 * desaturated grey by construction, and a crown of it read as frosted rather
 * than dark. The blue cast is real and worth keeping — it is what separates a
 * spruce from a broadleaf at a distance — but it belongs a step behind green,
 * not level with it.
 */
const SPRUCE_GREEN: LeafPalette = {
  shade: [0.116, 0.196, 0.142],
  sun: [0.184, 0.298, 0.186],
  weathered: [0.226, 0.244, 0.176],
  necrosis: [0.26, 0.226, 0.142],
}

/** Spruce needles are shorter, squarer in section and darker than a pine's. */
const SPRUCE_NEEDLE: LeafProfile = {
  ...PINE_NEEDLE,
  aspect: 0.085,
  translucency: 0.6,
  baseRoughness: 0.44,
  palette: SPRUCE_GREEN,
}

/** Redwood sprays are flat and two-ranked, with softer, broader needles. */
const REDWOOD_SPRAY: LeafProfile = {
  ...PINE_NEEDLE,
  aspect: 0.1,
  translucency: 0.68,
  palette: TROPICAL_GREEN,
}

/** Ceiba: five to nine elliptic leaflets on one long petiole. */
const CEIBA_PALMATE: LeafProfile = {
  family: 'palmate',
  aspect: 0.26,
  lobePairs: [0, 0],
  leaflets: [5, 8],
  baseRoughness: 0.44,
  translucency: 0.84,
  damage: 0.8,
  palette: TROPICAL_GREEN,
}

/** Baobab: fewer, broader, blunter leaflets than a ceiba, and greyer. */
const BAOBAB_PALMATE: LeafProfile = {
  ...CEIBA_PALMATE,
  aspect: 0.3,
  leaflets: [4, 6],
  translucency: 0.72,
  palette: { ...TROPICAL_GREEN, sun: [0.246, 0.35, 0.198] },
  spray: {
    scale: 0.84,
    count: 1.18,
    variantScale: [0.88, 1.04, 0.95, 1.1],
    minimumSquash: 0.2,
    tiltExponent: 0.48,
    angleJitter: 0.24,
    curl: 1.05,
    sizeVariation: [0.76, 1.16],
    pigment: [0.88, 1.05],
    petiole: [0.04, 0.09],
    // Whole baobab leaves have a clear petiole, but the atlas previously used
    // most of the card for it. At tree scale those repeated bare lines read as
    // wire spokes rather than compound foliage.
    axisScale: 0.62,
    spreadScale: 1.08,
    shootWidthScale: 0.82,
  },
}

/** Coconut: a long arching frond of many drooping strap leaflets. */
const COCONUT_FROND: LeafProfile = {
  family: 'pinnate-frond',
  aspect: 0.075,
  lobePairs: [0, 0],
  leaflets: [46, 58],
  baseRoughness: 0.4,
  translucency: 0.8,
  damage: 1.1,
  palette: PALM_GREEN,
}

/** Date: stiffer and greyer than a coconut, with narrower leaflets. */
const DATE_FROND: LeafProfile = {
  ...COCONUT_FROND,
  aspect: 0.038,
  leaflets: [76, 94],
  translucency: 0.66,
  baseRoughness: 0.46,
}

/** Tree fern: a twice-divided frond of small toothed pinnules. */
const FERN_FROND: LeafProfile = {
  family: 'fern-frond',
  aspect: 0.34,
  lobePairs: [0, 0],
  leaflets: [15, 21],
  baseRoughness: 0.5,
  translucency: 0.95,
  damage: 0.6,
  palette: FERN_GREEN,
}

/** Monkey puzzle: stiff overlapping triangular scales armouring the shoot. */
const ARAUCARIA_SCALE: LeafProfile = {
  family: 'scale-spray',
  aspect: 0.36,
  lobePairs: [0, 0],
  leaflets: [16, 24],
  baseRoughness: 0.36,
  translucency: 0.42,
  damage: 0.15,
  palette: { ...CONIFER_GREEN, sun: [0.2, 0.318, 0.2], shade: [0.14, 0.222, 0.15] },
}

/** Dragon blood: a dense terminal rosette of stiff blue-green blades. */
const DRAGON_ROSETTE: LeafProfile = {
  family: 'rosette',
  aspect: 0.072,
  lobePairs: [0, 0],
  leaflets: [26, 34],
  baseRoughness: 0.44,
  translucency: 0.5,
  damage: 0.35,
  palette: SUCCULENT_BLUE,
}

/** Quiver tree: fewer, fatter, more upright leaves than a dragon tree. */
const QUIVER_ROSETTE: LeafProfile = {
  ...DRAGON_ROSETTE,
  aspect: 0.105,
  leaflets: [18, 24],
  translucency: 0.4,
  baseRoughness: 0.38,
}

/**
 * Banyan: large, thick, glossy, entire ovate leaves on a normal alternate
 * shoot. No lobes at all, so the venation carries the whole read.
 */
const BANYAN_LEAF: LeafProfile = {
  family: 'broadleaf-simple',
  aspect: 0.36,
  lobePairs: [0, 0],
  leaflets: [1, 1],
  baseRoughness: 0.38,
  translucency: 0.7,
  damage: 0.7,
  palette: TROPICAL_GREEN,
}

/** Mangrove: smaller, thicker and waxier than a banyan, and bluer. */
const MANGROVE_LEAF: LeafProfile = {
  ...BANYAN_LEAF,
  aspect: 0.3,
  translucency: 0.52,
  baseRoughness: 0.34,
  damage: 0.4,
  palette: { ...TROPICAL_GREEN, sun: [0.2, 0.33, 0.2], shade: [0.128, 0.212, 0.15] },
}

/**
 * Fig: palmately lobed with three to five deep, blunt lobes — far fewer and
 * broader than an oak's, on a blade about as wide as it is long.
 */
const FIG_LEAF: LeafProfile = {
  family: 'broadleaf-lobed',
  aspect: 0.46,
  lobePairs: [2, 3],
  leaflets: [1, 1],
  baseRoughness: 0.46,
  translucency: 0.82,
  damage: 0.8,
  palette: TROPICAL_GREEN,
}

/** Doum palm: fan-palmate, not pinnate — stiff wedge segments off one hub. */
const DOUM_FROND: LeafProfile = {
  family: 'palmate',
  aspect: 0.14,
  lobePairs: [0, 0],
  leaflets: [11, 16],
  baseRoughness: 0.42,
  translucency: 0.6,
  damage: 0.9,
  palette: PALM_GREEN,
}

/** Joshua tree: a tight rosette of short, rigid, sharply pointed daggers. */
const JOSHUA_ROSETTE: LeafProfile = {
  family: 'rosette',
  aspect: 0.055,
  lobePairs: [0, 0],
  leaflets: [30, 40],
  baseRoughness: 0.5,
  translucency: 0.34,
  damage: 0.3,
  palette: { ...SUCCULENT_BLUE, sun: [0.256, 0.316, 0.238] },
}

/** Bristlecone: very short, tightly bottle-brushed needles on old wood. */
const BRISTLECONE_NEEDLE: LeafProfile = {
  ...PINE_NEEDLE,
  aspect: 0.075,
  translucency: 0.55,
  baseRoughness: 0.42,
  palette: { ...CONIFER_GREEN, shade: [0.146, 0.206, 0.166] },
}

/** Pandanus: long strap leaves in a spiral, held stiffly, keeled and toothed. */
const PANDANUS_SPIRAL: LeafProfile = {
  family: 'rosette',
  aspect: 0.045,
  lobePairs: [0, 0],
  leaflets: [22, 30],
  baseRoughness: 0.4,
  translucency: 0.72,
  damage: 0.7,
  palette: TROPICAL_GREEN,
}

/**
 * Live oak: small, thick, entire, strongly convex evergreen blades — nothing
 * like a deciduous oak's. The name is the only thing the two share.
 */
const LIVE_OAK_LEAF: LeafProfile = {
  family: 'broadleaf-simple',
  // Small and narrow. A live oak blade is a few centimetres of thick elliptic
  // tissue, nothing like the hand-sized lobed paddle of a deciduous oak, and
  // drawing it at deciduous scale is what makes the crown read as a heap of
  // bright green plates instead of a dense leathery mass.
  aspect: 0.2,
  lobePairs: [0, 0],
  leaflets: [1, 1],
  // Leathery and matte rather than waxed. The upper surface scatters far more
  // broadly than a fresh deciduous cuticle does.
  baseRoughness: 0.56,
  translucency: 0.6,
  damage: 0.7,
  palette: {
    // Dark olive throughout. Live oak is an evergreen carrying two seasons of
    // leaves at once; even its sun population never reaches the lime a spring
    // deciduous canopy does.
    shade: [0.138, 0.212, 0.144],
    sun: [0.226, 0.318, 0.184],
    weathered: [0.262, 0.25, 0.144],
    necrosis: [0.29, 0.244, 0.14],
  },
  spray: {
    // Many small blades rather than a few large ones.
    scale: 0.62,
    count: 1.55,
    // Real variety between atlas slots, not four reseeds of one size.
    variantScale: [0.84, 1, 1.16, 0.93],
    // A genuine tail of edge-on blades: a live oak crown is dense enough that
    // a good share of what the camera sees is a blade turned nearly sideways.
    minimumSquash: 0.11,
    tiltExponent: 0.52,
    angleJitter: 0.36,
    curl: 1.15,
    sizeVariation: [0.58, 1.38],
    pigment: [0.82, 1.06],
    // Near-sessile, on a very short stout stalk.
    petiole: [0.02, 0.055],
    // Compact evergreen twiglets. Long dark axes repeated on thousands of
    // cards read as hair and make terminal crown lobes look like antlers.
    axisScale: 0.78,
    spreadScale: 1.14,
    shootWidthScale: 0.58,
  },
}

/** Beech: thin, silky, wavy-margined and famously translucent in spring. */
const BEECH_LEAF: LeafProfile = {
  family: 'broadleaf-simple',
  aspect: 0.38,
  lobePairs: [0, 0],
  leaflets: [1, 1],
  baseRoughness: 0.5,
  // Well down from 0.96. Translucency is what makes a backlit leaf glow, and
  // it is the right effect — but at nearly one, every leaf in the canopy glows
  // whether it is backlit or not, and a closed stand seen from its own floor
  // is looking at the *shaded* side of almost all of them.
  translucency: 0.72,
  damage: 0.9,
  // The same correction the bark palette needed, for the same reason. These
  // were the greens of a sunlit specimen tree photographed against the sky:
  // under a closed canopy they rendered as a bright yellow-green ceiling that
  // sat two stops above everything beneath it and pulled the eye straight out
  // of the frame. Foliage in an interior is dark and slightly blue; the warm
  // yellow-green only appears where a gap backlights it, which is what the
  // translucency term is for.
  palette: {
    shade: [0.113, 0.181, 0.094],
    sun: [0.203, 0.297, 0.131],
    weathered: [0.214, 0.196, 0.09],
    necrosis: [0.203, 0.166, 0.088],
  },
  spray: {
    // The same correction as the oak's, and it matters more here: beech is
    // most of the default stand, so its card grain is the grain of the whole
    // forest. A beech blade is five to ten centimetres, which is smaller than
    // an oak's, and the shared default composition was drawing it at eighteen.
    //
    // Denser than the oak's because the blade is entire rather than lobed:
    // there is no deep sinus that has to survive the texel budget, so beech
    // takes more blades per shoot before they read as mush. Measured coverage
    // 0.250 against the previous 0.268.
    scale: 0.65,
    count: 4.2,
    variantScale: [0.88, 1.02, 1.15, 0.95],
    // Beech twiglets are famously flat and two-ranked — the blades lie in a
    // plane and present nearly face-on. Far fewer edge-on slivers than an oak.
    minimumSquash: 0.3,
    tiltExponent: 0.38,
    angleJitter: 0.24,
    // Thin and silky, so it cockles rather than curls.
    curl: 1.1,
    sizeVariation: [0.68, 1.26],
    pigment: [0.88, 1.08],
    petiole: [0.05, 0.1],
    spreadScale: 1.1,
    shootWidthScale: 0.68,
  },
}

/** Birch: small, sharply toothed, triangular, and held on fine pendulous shoots. */
const BIRCH_LEAF: LeafProfile = {
  family: 'broadleaf-lobed',
  aspect: 0.4,
  // Many shallow teeth rather than a few deep lobes; the lobe train doubles as
  // a serration train once the count is high and the sinuses stay shallow.
  lobePairs: [7, 10],
  leaflets: [1, 1],
  baseRoughness: 0.54,
  translucency: 0.92,
  damage: 1,
  palette: {
    shade: [0.196, 0.296, 0.162],
    sun: [0.316, 0.446, 0.222],
    weathered: [0.35, 0.33, 0.16],
    necrosis: [0.33, 0.28, 0.15],
  },
}

/** Acacia: twice-divided into hundreds of tiny leaflets — a fern-like frond. */
const ACACIA_COMPOUND: LeafProfile = {
  family: 'fern-frond',
  aspect: 0.36,
  lobePairs: [0, 0],
  leaflets: [16, 22],
  baseRoughness: 0.46,
  translucency: 0.9,
  damage: 0.9,
  palette: {
    shade: [0.176, 0.244, 0.152],
    sun: [0.284, 0.372, 0.212],
    weathered: [0.33, 0.31, 0.17],
    necrosis: [0.33, 0.29, 0.17],
  },
}

/** Eucalyptus: long, sickle-shaped, blue-grey blades hanging edge-on. */
const EUCALYPTUS_PENDULOUS: LeafProfile = {
  family: 'rosette',
  aspect: 0.09,
  lobePairs: [0, 0],
  leaflets: [10, 16],
  baseRoughness: 0.42,
  translucency: 0.74,
  damage: 0.8,
  palette: {
    shade: [0.2, 0.256, 0.208],
    sun: [0.316, 0.362, 0.28],
    weathered: [0.36, 0.33, 0.22],
    necrosis: [0.36, 0.3, 0.2],
  },
}

/** Sequoia: awl-shaped scale leaves on drooping cord-like sprays. */
const SEQUOIA_SPRAY: LeafProfile = {
  family: 'scale-spray',
  aspect: 0.26,
  lobePairs: [0, 0],
  leaflets: [20, 28],
  baseRoughness: 0.42,
  translucency: 0.5,
  damage: 0.2,
  palette: {
    shade: [0.148, 0.22, 0.162],
    sun: [0.222, 0.316, 0.216],
    weathered: [0.27, 0.26, 0.18],
    necrosis: [0.29, 0.25, 0.16],
  },
}

/** Cedar: very short needles in dense whorled rosettes on spur shoots. */
const CEDAR_NEEDLE: LeafProfile = {
  ...PINE_NEEDLE,
  aspect: 0.05,
  translucency: 0.58,
  palette: {
    shade: [0.164, 0.222, 0.184],
    sun: [0.24, 0.312, 0.244],
    weathered: [0.28, 0.27, 0.2],
    necrosis: [0.3, 0.26, 0.17],
  },
}

/** Japanese black pine: long, stiff, very dark paired needles. */
const BLACK_PINE_NEEDLE: LeafProfile = {
  ...PINE_NEEDLE,
  aspect: 0.052,
  translucency: 0.62,
  baseRoughness: 0.44,
  palette: {
    shade: [0.13, 0.192, 0.152],
    sun: [0.196, 0.278, 0.204],
    weathered: [0.24, 0.24, 0.17],
    necrosis: [0.28, 0.24, 0.15],
  },
}

/**
 * Foliage profiles, keyed by the catalog's `foliageProfile` rather than by
 * species id.
 *
 * The species catalog already routes a tree to a foliage family; re-deriving it
 * from the id here would mean two lists to keep in step, and the one in the
 * texture layer would be the one that silently fell behind — a new conifer
 * would come out wearing oak leaves and nothing would fail.
 */
/** Corylus: a broad, round, abruptly-pointed leaf with a doubly toothed edge. */
const HAZEL_LEAF: LeafProfile = {
  family: 'broadleaf-lobed',
  aspect: 0.42,
  lobePairs: [1, 2],
  leaflets: [1, 1],
  baseRoughness: 0.58,
  translucency: 0.9,
  damage: 0.9,
  palette: { ...TEMPERATE_GREEN, sun: [0.284, 0.418, 0.196] },
}

/** Sambucus: five to seven long-pointed leaflets on one stalk, coarsely toothed. */
const ELDER_PINNATE: LeafProfile = {
  family: 'palmate',
  aspect: 0.28,
  lobePairs: [0, 0],
  leaflets: [5, 7],
  baseRoughness: 0.5,
  translucency: 0.86,
  damage: 1,
  palette: { ...TEMPERATE_GREEN, sun: [0.26, 0.4, 0.19], shade: [0.15, 0.238, 0.14] },
}

/**
 * Juniperus: short, stiff, sharply pointed needles in threes, with a white
 * stomatal band down the upper face that makes a bush read grey-green from a
 * distance and green only close up.
 */
const JUNIPER_NEEDLE: LeafProfile = {
  family: 'needle-fascicle',
  aspect: 0.1,
  lobePairs: [0, 0],
  leaflets: [1, 1],
  baseRoughness: 0.5,
  translucency: 0.52,
  damage: 0.35,
  palette: {
    shade: [0.122, 0.176, 0.144],
    sun: [0.208, 0.272, 0.214],
    weathered: [0.226, 0.232, 0.184],
    necrosis: [0.24, 0.208, 0.14],
  },
}

const BY_FOLIAGE_PROFILE: Record<string, LeafProfile> = {
  ...EXTENDED_LEAF_PROFILES,
  'oak-lobed': OAK_LOBED,
  'hazel-leaf': HAZEL_LEAF,
  'elder-pinnate': ELDER_PINNATE,
  'juniper-needle': JUNIPER_NEEDLE,
  'pine-needle': PINE_NEEDLE,
  'spruce-needle': SPRUCE_NEEDLE,
  'redwood-spray': REDWOOD_SPRAY,
  'ceiba-palmate': CEIBA_PALMATE,
  'baobab-palmate': BAOBAB_PALMATE,
  'coconut-frond': COCONUT_FROND,
  'date-frond': DATE_FROND,
  'tree-fern-frond': FERN_FROND,
  'araucaria-scale': ARAUCARIA_SCALE,
  'dragon-blood-rosette': DRAGON_ROSETTE,
  'quiver-rosette': QUIVER_ROSETTE,
  'doum-frond': DOUM_FROND,
  'joshua-rosette': JOSHUA_ROSETTE,
  'bristlecone-needle': BRISTLECONE_NEEDLE,
  'pandanus-spiral': PANDANUS_SPIRAL,
  'banyan-leaf': BANYAN_LEAF,
  'mangrove-leaf': MANGROVE_LEAF,
  'fig-leaf': FIG_LEAF,
  'live-oak-leaf': LIVE_OAK_LEAF,
  'beech-leaf': BEECH_LEAF,
  'birch-leaf': BIRCH_LEAF,
  'acacia-compound': ACACIA_COMPOUND,
  'eucalyptus-pendulous': EUCALYPTUS_PENDULOUS,
  'sequoia-spray': SEQUOIA_SPRAY,
  'cedar-needle': CEDAR_NEEDLE,
  'black-pine-needle': BLACK_PINE_NEEDLE,
}

/**
 * Central species-to-foliage routing, mirroring the bark side. New tree ids
 * pick or add a leaf family here instead of threading string checks through
 * the layout, raster and palette code.
 */
export function leafProfileFor(species: TreeSpecies): LeafProfile {
  return BY_FOLIAGE_PROFILE[treeSpeciesDefinition(species).foliageProfile] ?? OAK_LOBED
}
