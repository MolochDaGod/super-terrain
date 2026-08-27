import { treeSpeciesDefinition } from '../../generator/speciesCatalog'
import type { TreeSpecies } from '../../generator/types'
import { EXTENDED_BARK_PROFILES } from './extendedProfiles'
import { LIVE_OAK_BARK } from './profiles/liveOak'
import { DATE_PALM_BARK } from './profiles/datePalm'
import { COCONUT_PALM_BARK } from './profiles/coconutPalm'
import type { BarkProfile } from './types'
import { DOUM_PALM_BARK } from './profiles/doumPalm'
import { DRAGON_BLOOD_BARK } from './profiles/dragonBlood'
import { BAOBAB_BARK } from './profiles/baobab'

/**
 * Mature English oak: deep vertical fissures cutting the bole into narrow
 * blocky plates, and every plate itself built out of overlapping grey-brown
 * cork scales that differ visibly from their neighbours in tint.
 *
 * That second half is the part a fissure network alone cannot supply, and its
 * absence is why the old profile rendered as a stained cylinder with grooves
 * routed into it. The fissures are the coarsest of three tiers, not the
 * material.
 */
const TEMPERATE_FISSURED: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'scaled-plates',
  columns: 20,
  plateAspect: 7,
  linkFrequency: [7, 42],
  minorFrequency: [44, 88],
  plateCyclesY: 7,
  furrowHalfWidth: 0.1,
  linkHalfWidth: 0.2,
  furrowDepth: 0.6,
  furrowStrength: 0.9,
  normalStrength: 6.5,
  // Oak scales are small relative to the plates and only slightly taller than
  // wide; the plate is what is elongated, not the flake.
  scaleDensity: 6,
  scaleAspect: 2.4,
  scaleLift: 0.45,
  scarAmount: 0.5,
  lichenAmount: 1,
  mossAmount: 0.7,
  grainAmount: 1.05,
  mosaicAmount: 0.85,
  furrowCoverage: 0.16,
  chipAmount: 0.75,
  furrowWidth: 0.16,
  palette: {
    fissure: [0.105, 0.09, 0.075],
    crown: [0.44, 0.405, 0.345],
    fresh: [0.5, 0.415, 0.305],
    lichen: [0.575, 0.585, 0.5],
    moss: [0.185, 0.255, 0.128],
  },
}

/**
 * Scots pine: broad flat orange-red plates that flake off in thin papery
 * scales, over a darker cracked base. The plates are large and few, and the
 * colour swing from scale to scale is enormous — grey-pink to burnt orange on
 * one hand's width of trunk.
 */
const RESINOUS_CONIFER: BarkProfile = {
  family: 'resinous-conifer',
  structure: 'scaled-plates',
  columns: 11,
  plateAspect: 3,
  linkFrequency: [9, 36],
  minorFrequency: [40, 80],
  plateCyclesY: 22,
  furrowHalfWidth: 0.13,
  linkHalfWidth: 0.1,
  furrowDepth: 0.42,
  furrowStrength: 0.85,
  furrowCoverage: 0.13,
  normalStrength: 5.5,
  scaleDensity: 2.2,
  scaleAspect: 1.25,
  scaleLift: 0.62,
  lichenAmount: 0.45,
  mossAmount: 0.2,
  mosaicAmount: 1.25,
  chipAmount: 0.7,
  palette: {
    fissure: [0.13, 0.085, 0.058],
    crown: [0.52, 0.355, 0.235],
    fresh: [0.7, 0.45, 0.26],
    lichen: [0.6, 0.59, 0.5],
    moss: [0.19, 0.25, 0.135],
  },
}

/**
 * Norway spruce: small round coppery scales, much finer and darker than a
 * pine's, over a purplish brown base. Sharing the pine profile was why three
 * separate conifers rendered as one material.
 */
const SPRUCE_SCALED: BarkProfile = {
  family: 'resinous-conifer',
  structure: 'scaled-plates',
  columns: 13,
  plateAspect: 3.6,
  linkFrequency: [9, 36],
  minorFrequency: [40, 80],
  plateCyclesY: 18,
  furrowHalfWidth: 0.11,
  linkHalfWidth: 0.1,
  furrowDepth: 0.36,
  furrowStrength: 0.7,
  furrowCoverage: 0.14,
  normalStrength: 5,
  scaleDensity: 2.2,
  scaleAspect: 1.1,
  scaleLift: 0.6,
  lichenAmount: 0.55,
  mossAmount: 0.35,
  mosaicAmount: 1.15,
  chipAmount: 0.4,
  palette: {
    fissure: [0.1, 0.072, 0.058],
    crown: [0.36, 0.255, 0.195],
    fresh: [0.47, 0.315, 0.22],
    lichen: [0.56, 0.56, 0.48],
    moss: [0.19, 0.25, 0.135],
  },
}

/**
 * Smooth barks — baobab, kapok, fig — barely fissure at all. What structure
 * they have is broad shedding patches and a swell over the wood beneath, and
 * their whole read is the mottling: irregular pale and grey-green regions with
 * soft boundaries. Running them through any plate structure carves a mature
 * fissure network into a surface that in life is almost polished.
 */
const SMOOTH_MOTTLED: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'mottled-smooth',
  columns: 4,
  plateAspect: 1.6,
  linkFrequency: [3, 5],
  minorFrequency: [12, 9],
  plateCyclesY: 3,
  furrowHalfWidth: 0.07,
  linkHalfWidth: 0.05,
  furrowDepth: 0.06,
  furrowStrength: 0.2,
  normalStrength: 3.2,
  scaleDensity: 2.4,
  scaleAspect: 2,
  scaleLift: 0.16,
  lichenAmount: 0.5,
  mossAmount: 0.4,
  grainAmount: 0.6,
  mosaicAmount: 0.55,
  palette: {
    fissure: [0.31, 0.305, 0.275],
    crown: [0.5, 0.5, 0.455],
    fresh: [0.47, 0.455, 0.395],
    lichen: [0.56, 0.575, 0.5],
    moss: [0.24, 0.29, 0.18],
  },
}

/** Long vertical fibre rather than plates: a palm's persistent leaf bases. */
const FIBROUS_PALM: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'ridged-furrows',
  columns: 22,
  plateAspect: 6,
  linkFrequency: [5, 4],
  minorFrequency: [44, 8],
  plateCyclesY: 3,
  furrowHalfWidth: 0.2,
  linkHalfWidth: 0.06,
  furrowDepth: 0.36,
  furrowStrength: 0.8,
  furrowCoverage: 0.28,
  normalStrength: 7,
  scaleDensity: 1.4,
  scaleAspect: 4,
  scaleLift: 0.4,
  mosaicAmount: 0.9,
  palette: {
    fissure: [0.17, 0.14, 0.105],
    crown: [0.44, 0.385, 0.3],
    fresh: [0.46, 0.375, 0.27],
    lichen: [0.55, 0.55, 0.48],
    moss: [0.21, 0.27, 0.15],
  },
}

/**
 * Coast redwood: very thick, soft, fibrous bark in deep vertical furrows, with
 * a strong red-brown cast and almost no lichen — it sheds too readily. The
 * furrows have to fork and terminate rather than closing around plates, which
 * is why this family runs on the crease field instead of a cell network.
 */
const FIBROUS_REDWOOD: BarkProfile = {
  family: 'resinous-conifer',
  structure: 'ridged-furrows',
  columns: 9,
  plateAspect: 7,
  linkFrequency: [6, 9],
  minorFrequency: [40, 10],
  plateCyclesY: 4,
  furrowHalfWidth: 0.22,
  linkHalfWidth: 0.14,
  furrowDepth: 0.6,
  furrowStrength: 0.95,
  furrowCoverage: 0.3,
  normalStrength: 6,
  scaleDensity: 1.2,
  scaleAspect: 5,
  scaleLift: 0.42,
  lichenAmount: 0.15,
  mossAmount: 0.15,
  mosaicAmount: 0.95,
  palette: {
    fissure: [0.105, 0.062, 0.042],
    crown: [0.42, 0.245, 0.16],
    fresh: [0.52, 0.3, 0.185],
    lichen: [0.5, 0.49, 0.43],
    moss: [0.2, 0.26, 0.14],
  },
}

/**
 * Tree fern: not bark at all but a mat of old frond bases and adventitious
 * roots — dense fine vertical fibre, very dark, and almost no plate structure.
 */
const FERN_FIBROUS: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'ridged-furrows',
  columns: 16,
  plateAspect: 9,
  linkFrequency: [8, 6],
  minorFrequency: [52, 12],
  plateCyclesY: 3,
  furrowHalfWidth: 0.24,
  linkHalfWidth: 0.1,
  furrowDepth: 0.5,
  furrowStrength: 0.9,
  furrowCoverage: 0.34,
  normalStrength: 7.5,
  scaleDensity: 1.6,
  scaleAspect: 7,
  scaleLift: 0.5,
  lichenAmount: 0.2,
  mossAmount: 0.7,
  mosaicAmount: 0.85,
  palette: {
    fissure: [0.07, 0.06, 0.05],
    crown: [0.27, 0.235, 0.185],
    fresh: [0.32, 0.27, 0.205],
    lichen: [0.42, 0.44, 0.38],
    moss: [0.19, 0.27, 0.15],
  },
}

/**
 * Quiver tree: smooth golden bark shedding in thin sharp-edged plates. The
 * plates are the whole identity, so this is a mottled bark with the scale
 * lift turned up rather than a fissured one.
 */
const SMOOTH_GOLDEN: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'mottled-smooth',
  columns: 6,
  plateAspect: 1.2,
  linkFrequency: [5, 6],
  minorFrequency: [16, 14],
  plateCyclesY: 4,
  furrowHalfWidth: 0.06,
  linkHalfWidth: 0.05,
  furrowDepth: 0.1,
  furrowStrength: 0.35,
  normalStrength: 4.5,
  scaleDensity: 2.4,
  scaleAspect: 1.2,
  scaleLift: 0.3,
  lichenAmount: 0.1,
  mossAmount: 0.05,
  mosaicAmount: 0.95,
  palette: {
    fissure: [0.3, 0.23, 0.135],
    crown: [0.62, 0.5, 0.31],
    fresh: [0.72, 0.6, 0.38],
    lichen: [0.6, 0.58, 0.47],
    moss: [0.24, 0.28, 0.17],
  },
}

/**
 * Fig and banyan: pale grey, almost smooth, with faint mottling, lenticels and
 * the soft vertical swelling of fused aerial roots.
 */
const FIG_SMOOTH: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'mottled-smooth',
  columns: 5,
  plateAspect: 1.3,
  linkFrequency: [4, 7],
  minorFrequency: [14, 12],
  plateCyclesY: 4,
  furrowHalfWidth: 0.055,
  linkHalfWidth: 0.045,
  furrowDepth: 0.07,
  furrowStrength: 0.25,
  normalStrength: 3.4,
  scaleDensity: 2.2,
  scaleAspect: 2.8,
  scaleLift: 0.13,
  lichenAmount: 0.55,
  mossAmount: 0.45,
  grainAmount: 0.55,
  mosaicAmount: 0.4,
  palette: {
    fissure: [0.34, 0.34, 0.315],
    crown: [0.55, 0.55, 0.515],
    fresh: [0.51, 0.5, 0.45],
    lichen: [0.6, 0.615, 0.55],
    moss: [0.24, 0.3, 0.19],
  },
}

/** Mangrove: rough, dark red-brown, shedding in small hard scales. */
const MANGROVE_SCALED: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'scaled-plates',
  columns: 13,
  plateAspect: 4.5,
  linkFrequency: [8, 30],
  minorFrequency: [40, 80],
  plateCyclesY: 10,
  furrowHalfWidth: 0.13,
  linkHalfWidth: 0.12,
  furrowDepth: 0.34,
  furrowStrength: 0.9,
  furrowCoverage: 0.16,
  normalStrength: 6,
  scaleDensity: 2.1,
  scaleAspect: 1.15,
  scaleLift: 0.68,
  lichenAmount: 0.3,
  mossAmount: 0.25,
  mosaicAmount: 1.1,
  chipAmount: 0.5,
  palette: {
    fissure: [0.09, 0.068, 0.058],
    crown: [0.35, 0.26, 0.215],
    fresh: [0.44, 0.33, 0.25],
    lichen: [0.5, 0.5, 0.45],
    moss: [0.2, 0.27, 0.16],
  },
}

/** Joshua tree: a shaggy skirt of dead leaf bases, coarse and untidy. */
const SHAGGY_YUCCA: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'ridged-furrows',
  columns: 14,
  plateAspect: 4.5,
  linkFrequency: [7, 26],
  minorFrequency: [36, 72],
  plateCyclesY: 5,
  furrowHalfWidth: 0.2,
  linkHalfWidth: 0.16,
  furrowDepth: 0.46,
  furrowStrength: 0.9,
  furrowCoverage: 0.28,
  normalStrength: 7,
  scaleDensity: 2,
  scaleAspect: 3,
  scaleLift: 0.6,
  lichenAmount: 0.1,
  mossAmount: 0.05,
  mosaicAmount: 1.05,
  palette: {
    fissure: [0.1, 0.082, 0.062],
    crown: [0.37, 0.315, 0.235],
    fresh: [0.45, 0.385, 0.28],
    lichen: [0.5, 0.5, 0.44],
    moss: [0.2, 0.25, 0.15],
  },
}

/**
 * Bristlecone: as much bare weathered deadwood as bark. Wind-polished, silver
 * grey, and grooved along the grain rather than fissured into plates, with
 * warm resin-stained streaks where living bark survives.
 */
const WEATHERED_DEADWOOD: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'ridged-furrows',
  columns: 10,
  plateAspect: 8,
  linkFrequency: [6, 10],
  minorFrequency: [34, 68],
  plateCyclesY: 3,
  furrowHalfWidth: 0.17,
  linkHalfWidth: 0.07,
  furrowDepth: 0.44,
  furrowStrength: 0.88,
  furrowCoverage: 0.24,
  normalStrength: 6.5,
  scaleDensity: 1.3,
  scaleAspect: 6,
  scaleLift: 0.45,
  lichenAmount: 0.3,
  mossAmount: 0.05,
  mosaicAmount: 1,
  palette: {
    fissure: [0.19, 0.175, 0.155],
    crown: [0.56, 0.545, 0.505],
    fresh: [0.47, 0.4, 0.315],
    lichen: [0.62, 0.62, 0.56],
    moss: [0.24, 0.28, 0.2],
  },
}

/** Pandanus: smooth grey-green trunk banded by old leaf scars. */
const PANDANUS_RINGED: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'papery-strips',
  columns: 5,
  plateAspect: 0.42,
  linkFrequency: [4, 30],
  minorFrequency: [18, 20],
  plateCyclesY: 34,
  furrowHalfWidth: 0.09,
  linkHalfWidth: 0.06,
  furrowDepth: 0.18,
  furrowStrength: 0.7,
  normalStrength: 5,
  scaleDensity: 0.9,
  scaleAspect: 0.4,
  scaleLift: 0.3,
  lichenAmount: 0.35,
  mossAmount: 0.4,
  mosaicAmount: 0.6,
  palette: {
    fissure: [0.22, 0.23, 0.195],
    crown: [0.45, 0.465, 0.415],
    fresh: [0.42, 0.43, 0.37],
    lichen: [0.54, 0.56, 0.5],
    moss: [0.22, 0.29, 0.17],
  },
}

/** Savanna acacia: dark, coarsely fissured into small blocky plates. */
const SAVANNA_FISSURED: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'scaled-plates',
  columns: 14,
  plateAspect: 5,
  linkFrequency: [7, 34],
  minorFrequency: [42, 84],
  plateCyclesY: 9,
  furrowHalfWidth: 0.12,
  linkHalfWidth: 0.22,
  furrowDepth: 0.4,
  furrowStrength: 0.92,
  furrowCoverage: 0.19,
  normalStrength: 6.5,
  scaleDensity: 1.9,
  scaleAspect: 1.3,
  scaleLift: 0.66,
  lichenAmount: 0.25,
  mossAmount: 0.1,
  mosaicAmount: 1.05,
  chipAmount: 0.5,
  palette: {
    fissure: [0.1, 0.083, 0.068],
    crown: [0.37, 0.325, 0.265],
    fresh: [0.44, 0.375, 0.29],
    lichen: [0.52, 0.52, 0.46],
    moss: [0.2, 0.26, 0.15],
  },
}

/**
 * Rainbow eucalyptus: bark shed in ribbons, exposing streaks of green, blue,
 * orange and maroon that age through the whole sequence. Almost no fissuring —
 * the colour *is* the material. It is the one profile where the per-scale
 * mosaic is the entire point rather than a corrective, so the patches are
 * large, strongly elongated, and the mosaic runs well above one.
 */
const RAINBOW_PEELING: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'mottled-smooth',
  columns: 7,
  plateAspect: 9,
  linkFrequency: [4, 9],
  minorFrequency: [20, 40],
  plateCyclesY: 3,
  furrowHalfWidth: 0.11,
  linkHalfWidth: 0.16,
  furrowDepth: 0.08,
  furrowStrength: 0.3,
  normalStrength: 3.4,
  scaleDensity: 2.2,
  scaleAspect: 4.5,
  scaleLift: 0.24,
  lichenAmount: 0.05,
  mossAmount: 0.1,
  grainAmount: 0.5,
  mosaicAmount: 1.5,
  palette: {
    fissure: [0.16, 0.28, 0.22],
    crown: [0.5, 0.42, 0.28],
    fresh: [0.62, 0.3, 0.2],
    lichen: [0.3, 0.42, 0.4],
    moss: [0.18, 0.34, 0.26],
  },
}

/** Gum eucalyptus: smooth, shedding in patches, mottled grey-cream-tan. */
const GUM_MOTTLED: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'mottled-smooth',
  columns: 5,
  plateAspect: 3.5,
  linkFrequency: [4, 8],
  minorFrequency: [16, 32],
  plateCyclesY: 4,
  furrowHalfWidth: 0.08,
  linkHalfWidth: 0.14,
  furrowDepth: 0.07,
  furrowStrength: 0.25,
  normalStrength: 3.2,
  scaleDensity: 1.9,
  scaleAspect: 2.6,
  scaleLift: 0.2,
  lichenAmount: 0.2,
  mossAmount: 0.1,
  grainAmount: 0.5,
  mosaicAmount: 1,
  palette: {
    fissure: [0.35, 0.325, 0.275],
    crown: [0.63, 0.615, 0.56],
    fresh: [0.56, 0.47, 0.36],
    lichen: [0.64, 0.645, 0.58],
    moss: [0.24, 0.3, 0.2],
  },
}

/** Giant sequoia: very thick, soft, deeply furrowed, strongly cinnamon-red. */
const FIBROUS_SEQUOIA: BarkProfile = {
  family: 'resinous-conifer',
  structure: 'ridged-furrows',
  columns: 8,
  plateAspect: 6.5,
  linkFrequency: [6, 10],
  minorFrequency: [38, 76],
  plateCyclesY: 4,
  furrowHalfWidth: 0.2,
  linkHalfWidth: 0.16,
  furrowDepth: 0.58,
  furrowStrength: 0.95,
  furrowCoverage: 0.32,
  normalStrength: 6.5,
  scaleDensity: 1.15,
  scaleAspect: 5.5,
  scaleLift: 0.45,
  lichenAmount: 0.1,
  mossAmount: 0.12,
  mosaicAmount: 1,
  palette: {
    fissure: [0.115, 0.062, 0.04],
    crown: [0.46, 0.255, 0.155],
    fresh: [0.56, 0.315, 0.185],
    lichen: [0.5, 0.48, 0.42],
    moss: [0.2, 0.26, 0.14],
  },
}

/**
 * Beech: famously smooth pale grey, with fine horizontal lenticel bands and
 * broad soft blotches of algal green. Nothing on it is a crack, so the mosaic
 * is deliberately weak — beech cork really is uniform, and this is one of the
 * few barks where per-scale variation would be the wrong answer.
 */
const BEECH_SMOOTH: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'mottled-smooth',
  columns: 4,
  plateAspect: 0.9,
  linkFrequency: [3, 22],
  minorFrequency: [12, 24],
  plateCyclesY: 18,
  furrowHalfWidth: 0.05,
  linkHalfWidth: 0.06,
  furrowDepth: 0.04,
  furrowStrength: 0.18,
  // High, because the fields it differentiates are fine and low-contrast.
  // `normalStrength` scales the *gradient* of the relief field, so a surface
  // made of granulation and striation rather than of fissures needs several
  // times the gain of a plated bark to produce the same slope.
  normalStrength: 14,
  // Above the new default. A smooth bark's relief is low-amplitude by
  // definition — fine cork grain and lenticel scars, no fissures — so it needs
  // more gain than a plated one to show the same amount of surface.
  runtimeNormalScale: 0.95,
  // Beech has no plates and no scales. What little tonal structure it carries
  // is a fine algal mottle a few centimetres across, so the scale tier runs
  // three times finer than it did and contributes almost no per-cell tint:
  // at the old density and mosaic strength the tile came out as a wall of
  // hand-sized polygons, which is a reptile or a flagstone, not a beech.
  scaleDensity: 20,
  scaleAspect: 1.6,
  // Zero, and the review that got here is worth recording.
  //
  // `scaleLift` is how far a scale stands proud of its neighbours, and every
  // downstream pass reads the relief it produces: exposure shades each cell,
  // occlusion draws a line round it, and the albedo mosaic tints it. On a
  // scaled bark that stack is the whole material. On a smooth one it is a
  // liability — the tile came out as a wall of outlined polygons, the single
  // loudest procedural tell in a stand of beeches, and turning `mosaicAmount`
  // down never touched it because the mosaic was not what drew them.
  //
  // Two intermediate values looked like they fixed it and did not. Both were
  // judged from 512-wide preview bakes, and the cells are about 2cm on a
  // 1.6-metre tile: under 512 they fall below a texel and dissolve into mush
  // that reads as a soft mottle. At the 1024 the renderer actually bakes they
  // came straight back, unchanged. Any bark judgement taken below the shipping
  // resolution is a judgement about the downsample.
  //
  // Beech is genuinely smooth. What it has instead is vertical cork grain and
  // an algal film, which is what `grainAmount` and `lichenAmount` below carry.
  scaleLift: 0,
  lichenAmount: 0.55,
  // The baked map covers the whole tile at every height, so the green in it
  // is the algal film a beech carries everywhere, not the moss colony. The
  // colony is height-dependent and belongs to the material, which is why this
  // came down when the runtime one went in: both at full strength painted a
  // thirty-metre bole green to its crown.
  mossAmount: 0.24,
  // Grain and mosaic carry the character the relief no longer does: vertical
  // cork streaking, and per-patch tint that is now free to be visible because
  // it is no longer riding on top of an outlined cell.
  grainAmount: 1.1,
  // Nothing to tint. Per-cell colour without per-cell relief is a flat
  // patchwork, which is the same tell arriving by a different route.
  mosaicAmount: 0,
  // Wet-forest beech, not a specimen tree on a dry lawn.
  //
  // The old palette sat around 0.6, which is close to fresh concrete, and
  // under a strong key it rendered as bone-white ceramic — the single loudest
  // "procedural" tell in a stand of them. Beech in the shade of its own canopy
  // is a mid grey with a green cast from the algal film that covers it, and
  // dropping the whole ramp about a third is what puts the trunks back into
  // the same tonal range as the litter they stand in.
  palette: {
    fissure: [0.175, 0.182, 0.168],
    crown: [0.325, 0.332, 0.312],
    fresh: [0.29, 0.292, 0.268],
    lichen: [0.4, 0.412, 0.36],
    moss: [0.17, 0.225, 0.13],
  },
}

/**
 * Silver birch: white, papery, peeling in horizontal strips, with black
 * lenticel dashes drawn straight across the grain. Its structure is transverse
 * and laminar rather than a network at all — every plate primitive in the
 * library produced a cracked-mud sheet nobody would identify as birch.
 */
const BIRCH_WHITE: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'papery-strips',
  columns: 3,
  plateAspect: 0.28,
  linkFrequency: [3, 40],
  minorFrequency: [10, 46],
  plateCyclesY: 26,
  furrowHalfWidth: 0.06,
  linkHalfWidth: 0.1,
  furrowDepth: 0.12,
  furrowStrength: 0.5,
  normalStrength: 4,
  scaleDensity: 0.6,
  scaleAspect: 0.35,
  scaleLift: 0.22,
  scarAmount: 0.25,
  lichenAmount: 0.3,
  mossAmount: 0.15,
  grainAmount: 0.4,
  mosaicAmount: 0.45,
  palette: {
    fissure: [0.11, 0.105, 0.1],
    crown: [0.85, 0.845, 0.825],
    fresh: [0.72, 0.66, 0.575],
    lichen: [0.74, 0.745, 0.69],
    moss: [0.26, 0.32, 0.2],
  },
}

/** Cedar of Lebanon: dark grey-brown, finely and densely scaled. */
const CONIFER_FISSURED: BarkProfile = {
  family: 'resinous-conifer',
  structure: 'scaled-plates',
  columns: 14,
  plateAspect: 5.5,
  linkFrequency: [8, 38],
  minorFrequency: [44, 88],
  plateCyclesY: 10,
  furrowHalfWidth: 0.11,
  linkHalfWidth: 0.22,
  furrowDepth: 0.38,
  furrowStrength: 0.9,
  furrowCoverage: 0.18,
  normalStrength: 6,
  scaleDensity: 2.1,
  scaleAspect: 1.35,
  scaleLift: 0.6,
  lichenAmount: 0.45,
  mossAmount: 0.3,
  mosaicAmount: 1,
  chipAmount: 0.45,
  palette: {
    fissure: [0.095, 0.085, 0.075],
    crown: [0.34, 0.32, 0.29],
    fresh: [0.4, 0.355, 0.3],
    lichen: [0.52, 0.52, 0.46],
    moss: [0.2, 0.26, 0.16],
  },
}

/** Japanese black pine: near-black plates split by deep grey-orange fissures. */
const PINE_PLATED_DARK: BarkProfile = {
  family: 'resinous-conifer',
  structure: 'scaled-plates',
  columns: 10,
  plateAspect: 3.4,
  linkFrequency: [7, 28],
  minorFrequency: [36, 72],
  plateCyclesY: 8,
  furrowHalfWidth: 0.15,
  linkHalfWidth: 0.2,
  furrowDepth: 0.5,
  furrowStrength: 0.95,
  furrowCoverage: 0.2,
  normalStrength: 7,
  scaleDensity: 1.9,
  scaleAspect: 1.2,
  // Black pine's plates stand further off the trunk than any other conifer's;
  // the depth of that stack is the species' whole silhouette at close range.
  scaleLift: 0.85,
  lichenAmount: 0.35,
  mossAmount: 0.2,
  mosaicAmount: 1.15,
  chipAmount: 0.6,
  palette: {
    fissure: [0.22, 0.135, 0.085],
    crown: [0.2, 0.18, 0.16],
    fresh: [0.33, 0.27, 0.22],
    lichen: [0.46, 0.46, 0.42],
    moss: [0.19, 0.25, 0.15],
  },
}

/**
 * Monkey puzzle: thick, grey, deeply wrinkled bark in broad transverse folds,
 * closer to elephant hide than to any plated conifer. It shared the Scots pine
 * recipe, which is why an araucaria came out orange.
 */
const ARAUCARIA_WRINKLED: BarkProfile = {
  family: 'resinous-conifer',
  structure: 'scaled-plates',
  columns: 7,
  plateAspect: 0.4,
  linkFrequency: [6, 20],
  minorFrequency: [30, 40],
  plateCyclesY: 14,
  furrowHalfWidth: 0.14,
  linkHalfWidth: 0.12,
  furrowDepth: 0.4,
  furrowStrength: 0.85,
  furrowCoverage: 0.18,
  normalStrength: 6,
  scaleDensity: 1.4,
  scaleAspect: 0.45,
  scaleLift: 0.55,
  lichenAmount: 0.4,
  mossAmount: 0.35,
  mosaicAmount: 0.8,
  palette: {
    fissure: [0.115, 0.11, 0.1],
    crown: [0.36, 0.35, 0.325],
    fresh: [0.4, 0.375, 0.335],
    lichen: [0.53, 0.535, 0.48],
    moss: [0.2, 0.26, 0.16],
  },
}

/**
 * Norfolk Island pine: brown, papery, peeling in horizontal bands around a
 * comparatively smooth bole.
 */
const NORFOLK_PEELING: BarkProfile = {
  family: 'resinous-conifer',
  structure: 'papery-strips',
  columns: 5,
  plateAspect: 0.5,
  linkFrequency: [5, 24],
  minorFrequency: [20, 36],
  plateCyclesY: 22,
  furrowHalfWidth: 0.08,
  linkHalfWidth: 0.08,
  furrowDepth: 0.16,
  furrowStrength: 0.55,
  normalStrength: 4.5,
  scaleDensity: 0.8,
  scaleAspect: 0.45,
  scaleLift: 0.3,
  lichenAmount: 0.3,
  mossAmount: 0.25,
  mosaicAmount: 0.85,
  palette: {
    fissure: [0.16, 0.125, 0.098],
    crown: [0.42, 0.35, 0.28],
    fresh: [0.5, 0.41, 0.31],
    lichen: [0.55, 0.55, 0.48],
    moss: [0.2, 0.27, 0.16],
  },
}

/**
 * Kapok / ceiba: a green-grey, almost polished bole, banded and studded with
 * conical spines on young stems. Smooth, and distinctly green — nothing like
 * the grey of a fig.
 */
const TROPICAL_GREEN_SMOOTH: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'mottled-smooth',
  columns: 4,
  plateAspect: 2.2,
  linkFrequency: [3, 6],
  minorFrequency: [12, 14],
  plateCyclesY: 4,
  furrowHalfWidth: 0.06,
  linkHalfWidth: 0.05,
  furrowDepth: 0.06,
  furrowStrength: 0.2,
  normalStrength: 3,
  scaleDensity: 2.4,
  scaleAspect: 2.6,
  scaleLift: 0.13,
  lichenAmount: 0.45,
  mossAmount: 0.55,
  grainAmount: 0.5,
  mosaicAmount: 0.45,
  palette: {
    fissure: [0.245, 0.265, 0.215],
    crown: [0.44, 0.475, 0.4],
    fresh: [0.47, 0.485, 0.4],
    lichen: [0.56, 0.585, 0.5],
    moss: [0.23, 0.31, 0.185],
  },
}

/**
 * Bark profiles, keyed by the catalog's `barkProfile` rather than by species
 * id. Re-deriving the family from the id here would leave two lists to keep in
 * step, and a new conifer would silently come out wearing oak bark.
 */
const BY_BARK_PROFILE: Record<string, BarkProfile> = {
  ...EXTENDED_BARK_PROFILES,
  'live-oak-fissured': LIVE_OAK_BARK,
  'temperate-fissured': TEMPERATE_FISSURED,
  // Three conifers used to share one recipe, so a spruce, a Scots pine and a
  // monkey puzzle all rendered as the same orange crocodile hide. They are
  // three quite different barks and now have three profiles.
  'conifer-plated': RESINOUS_CONIFER,
  'conifer-scaled': SPRUCE_SCALED,
  'araucaria-wrinkled': ARAUCARIA_WRINKLED,
  'norfolk-peeling': NORFOLK_PEELING,
  'tropical-buttressed': TROPICAL_GREEN_SMOOTH,
  'smooth-grey': SMOOTH_MOTTLED,
  'baobab-smooth': BAOBAB_BARK,
  'smooth-mottled': SMOOTH_MOTTLED,
  'fibrous-palm': FIBROUS_PALM,
  'date-palm-boots': DATE_PALM_BARK,
  'coconut-ringed': COCONUT_PALM_BARK,
  'doum-palm-boots': DOUM_PALM_BARK,
  'dragon-scaled': DRAGON_BLOOD_BARK,
  'fibrous-redwood': FIBROUS_REDWOOD,
  'fern-fibrous': FERN_FIBROUS,
  'smooth-golden': SMOOTH_GOLDEN,
  'shaggy-yucca': SHAGGY_YUCCA,
  'weathered-deadwood': WEATHERED_DEADWOOD,
  'pandanus-ringed': PANDANUS_RINGED,
  'fig-smooth': FIG_SMOOTH,
  'mangrove-scaled': MANGROVE_SCALED,
  'savanna-fissured': SAVANNA_FISSURED,
  'rainbow-peeling': RAINBOW_PEELING,
  'gum-mottled': GUM_MOTTLED,
  'fibrous-sequoia': FIBROUS_SEQUOIA,
  'beech-smooth': BEECH_SMOOTH,
  'birch-white': BIRCH_WHITE,
  'conifer-fissured': CONIFER_FISSURED,
  'pine-plated-dark': PINE_PLATED_DARK,
}

/**
 * Central species-to-material routing. New tree ids can select or introduce a
 * bark family here without spreading string checks through the field bake.
 */
export function barkProfileFor(species: TreeSpecies): BarkProfile {
  return BY_BARK_PROFILE[treeSpeciesDefinition(species).barkProfile] ??
    TEMPERATE_FISSURED
}
