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
 * Mature English oak: deep vertical fissures cutting a bole into narrow
 * blocky plates, the crowns bleached grey-brown and lichened, the fissures
 * nearly black.
 */
const TEMPERATE_FISSURED: BarkProfile = {
  family: 'fissured-hardwood',
  structure: 'columnar-fissures',
  // A mature oak fissures every five to eight centimetres, so a 1.6-metre tile
  // carries something near twenty plates around it.
  columns: 22,
  // Chunky, not scratchy. Plates several times taller than wide come out as
  // ruled vertical grooves; a live oak's are irregular blocks about twice as
  // tall as they are broad, and the difference between those two numbers is
  // the difference between bark and brushed timber.
  plateAspect: 2.8,
  linkFrequency: [7, 42],
  minorFrequency: [44, 88],
  plateCyclesY: 7,
  // Calibrated against measured maps, not by eye. The previous values put the
  // albedo range at 0.05, the saturation range at 0.014 and the fraction of
  // the surface with any slope at all at 0.0% — a flat painted cylinder, which
  // is exactly what it rendered as. The opposite extreme is just as wrong: a
  // wall past about seventy degrees points away from every light in the scene
  // and comes back as a black line, so the relief has a ceiling too.
  furrowHalfWidth: 0.1,
  linkHalfWidth: 0.2,
  furrowDepth: 0.32,
  furrowStrength: 0.78,
  normalStrength: 6,
  // Lichen and moss have to separate. A trunk carrying a uniform wash of both
  // reads as dirt; the whole cue is crustose lichen holding the dry open
  // crowns while moss keeps to the damp shelter of the fissures.
  scarAmount: 0.5,
  lichenAmount: 0.95,
  mossAmount: 0.62,
  grainAmount: 0.9,
  palette: {
    // Weathered oak plate measures around saturation 0.2 — grey-brown, not
    // grey. Flattening the crown toward neutral dropped the whole trunk to
    // 0.07 and it came back looking like cast concrete.
    fissure: [0.15, 0.126, 0.104],
    crown: [0.42, 0.396, 0.345],
    fresh: [0.462, 0.428, 0.368],
    lichen: [0.55, 0.565, 0.51],
    moss: [0.185, 0.255, 0.128],
  },
}

/** Scots-pine style: orange-red flaking plates over a darker fissured base. */
const RESINOUS_CONIFER: BarkProfile = {
  family: 'resinous-conifer',
  columns: 20,
  plateAspect: 2.2,
  linkFrequency: [9, 36],
  minorFrequency: [40, 80],
  plateCyclesY: 22,
  furrowHalfWidth: 0.13,
  linkHalfWidth: 0.1,
  furrowDepth: 0.55,
  furrowStrength: 0.85,
  normalStrength: 6.5,
  palette: {
    fissure: [0.155, 0.115, 0.086],
    crown: [0.52, 0.38, 0.265],
    fresh: [0.6, 0.42, 0.27],
    lichen: [0.56, 0.56, 0.49],
    moss: [0.19, 0.25, 0.135],
  },
}

/**
 * Smooth barks — baobab, dragon blood — are a different organ entirely: they
 * barely fissure at all, and what structure they have is broad mottling rather
 * than plates. Running them through the oak profile would carve a mature
 * fissure network into a surface that in life is almost polished.
 */
const SMOOTH_MOTTLED: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 4,
  plateAspect: 1.6,
  linkFrequency: [3, 5],
  minorFrequency: [12, 9],
  plateCyclesY: 3,
  furrowHalfWidth: 0.07,
  linkHalfWidth: 0.05,
  furrowDepth: 0.14,
  furrowStrength: 0.35,
  normalStrength: 5,
  palette: {
    fissure: [0.3, 0.29, 0.26],
    crown: [0.52, 0.5, 0.45],
    fresh: [0.47, 0.44, 0.38],
    lichen: [0.58, 0.585, 0.52],
    moss: [0.24, 0.29, 0.18],
  },
}

/** Long vertical fibre rather than plates: a palm's persistent leaf bases. */
const FIBROUS_PALM: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 22,
  plateAspect: 6,
  linkFrequency: [5, 4],
  minorFrequency: [44, 8],
  plateCyclesY: 3,
  furrowHalfWidth: 0.2,
  linkHalfWidth: 0.06,
  furrowDepth: 0.4,
  furrowStrength: 0.8,
  normalStrength: 8.5,
  palette: {
    fissure: [0.19, 0.16, 0.125],
    crown: [0.44, 0.395, 0.315],
    fresh: [0.42, 0.36, 0.27],
    lichen: [0.55, 0.55, 0.48],
    moss: [0.21, 0.27, 0.15],
  },
}

/**
 * Coast redwood: very thick, soft, fibrous bark in deep vertical furrows, with
 * a strong red-brown cast and almost no lichen — it sheds too readily.
 */
const FIBROUS_REDWOOD: BarkProfile = {
  family: 'resinous-conifer',
  columns: 7,
  plateAspect: 7,
  linkFrequency: [6, 9],
  minorFrequency: [40, 10],
  plateCyclesY: 4,
  furrowHalfWidth: 0.22,
  linkHalfWidth: 0.14,
  furrowDepth: 0.7,
  furrowStrength: 0.95,
  normalStrength: 6.5,
  palette: {
    fissure: [0.13, 0.088, 0.066],
    crown: [0.44, 0.31, 0.235],
    fresh: [0.5, 0.34, 0.24],
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
  columns: 26,
  plateAspect: 9,
  linkFrequency: [8, 6],
  minorFrequency: [52, 12],
  plateCyclesY: 3,
  furrowHalfWidth: 0.24,
  linkHalfWidth: 0.1,
  furrowDepth: 0.5,
  furrowStrength: 0.9,
  normalStrength: 9.5,
  palette: {
    fissure: [0.088, 0.076, 0.062],
    crown: [0.29, 0.262, 0.216],
    fresh: [0.33, 0.29, 0.23],
    lichen: [0.42, 0.44, 0.38],
    moss: [0.19, 0.27, 0.15],
  },
}

/** Quiver tree: smooth golden bark shedding in thin sharp-edged plates. */
const SMOOTH_GOLDEN: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 6,
  plateAspect: 1.2,
  linkFrequency: [5, 6],
  minorFrequency: [16, 14],
  plateCyclesY: 4,
  furrowHalfWidth: 0.06,
  linkHalfWidth: 0.05,
  furrowDepth: 0.24,
  furrowStrength: 0.5,
  normalStrength: 6.5,
  palette: {
    fissure: [0.28, 0.22, 0.14],
    crown: [0.6, 0.5, 0.33],
    fresh: [0.66, 0.56, 0.37],
    lichen: [0.58, 0.56, 0.47],
    moss: [0.24, 0.28, 0.17],
  },
}

/** Fig and banyan: pale grey, almost smooth, with faint mottling and lenticels. */
const FIG_SMOOTH: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 5,
  plateAspect: 1.3,
  linkFrequency: [4, 7],
  minorFrequency: [14, 12],
  plateCyclesY: 4,
  furrowHalfWidth: 0.055,
  linkHalfWidth: 0.045,
  furrowDepth: 0.16,
  furrowStrength: 0.4,
  normalStrength: 4.5,
  palette: {
    fissure: [0.33, 0.33, 0.3],
    crown: [0.56, 0.555, 0.51],
    fresh: [0.52, 0.5, 0.44],
    lichen: [0.6, 0.61, 0.55],
    moss: [0.24, 0.3, 0.19],
  },
}

/** Mangrove: rough, dark red-brown, shedding in small hard scales. */
const MANGROVE_SCALED: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 20,
  plateAspect: 1.5,
  linkFrequency: [8, 30],
  minorFrequency: [40, 80],
  plateCyclesY: 10,
  furrowHalfWidth: 0.13,
  linkHalfWidth: 0.12,
  furrowDepth: 0.5,
  furrowStrength: 0.9,
  normalStrength: 10,
  palette: {
    fissure: [0.105, 0.082, 0.07],
    crown: [0.36, 0.278, 0.228],
    fresh: [0.42, 0.32, 0.25],
    lichen: [0.5, 0.5, 0.45],
    moss: [0.2, 0.27, 0.16],
  },
}

/** Joshua tree: a shaggy skirt of dead leaf bases, coarse and untidy. */
const SHAGGY_YUCCA: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 18,
  plateAspect: 4.5,
  linkFrequency: [7, 26],
  minorFrequency: [36, 72],
  plateCyclesY: 5,
  furrowHalfWidth: 0.2,
  linkHalfWidth: 0.16,
  furrowDepth: 0.6,
  furrowStrength: 0.9,
  normalStrength: 10,
  palette: {
    fissure: [0.11, 0.095, 0.078],
    crown: [0.36, 0.318, 0.248],
    fresh: [0.41, 0.36, 0.27],
    lichen: [0.5, 0.5, 0.44],
    moss: [0.2, 0.25, 0.15],
  },
}

/**
 * Bristlecone: as much bare weathered deadwood as bark. Wind-polished, silver
 * grey, and grooved along the grain rather than fissured into plates.
 */
const WEATHERED_DEADWOOD: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 14,
  plateAspect: 8,
  linkFrequency: [6, 10],
  minorFrequency: [34, 68],
  plateCyclesY: 3,
  furrowHalfWidth: 0.17,
  linkHalfWidth: 0.07,
  furrowDepth: 0.52,
  furrowStrength: 0.88,
  normalStrength: 10,
  palette: {
    fissure: [0.2, 0.19, 0.176],
    crown: [0.55, 0.535, 0.5],
    fresh: [0.5, 0.47, 0.42],
    lichen: [0.6, 0.6, 0.55],
    moss: [0.24, 0.28, 0.2],
  },
}

/** Pandanus: smooth grey-green trunk banded by old leaf scars. */
const PANDANUS_RINGED: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 5,
  plateAspect: 0.42,
  linkFrequency: [4, 30],
  minorFrequency: [18, 20],
  plateCyclesY: 26,
  furrowHalfWidth: 0.09,
  linkHalfWidth: 0.06,
  furrowDepth: 0.3,
  furrowStrength: 0.7,
  normalStrength: 7,
  palette: {
    fissure: [0.23, 0.235, 0.2],
    crown: [0.46, 0.47, 0.42],
    fresh: [0.42, 0.43, 0.37],
    lichen: [0.54, 0.56, 0.5],
    moss: [0.22, 0.29, 0.17],
  },
}

/** Savanna acacia: dark, coarsely fissured into small blocky plates. */
const SAVANNA_FISSURED: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 24,
  plateAspect: 1.7,
  linkFrequency: [7, 34],
  minorFrequency: [42, 84],
  plateCyclesY: 9,
  furrowHalfWidth: 0.12,
  linkHalfWidth: 0.22,
  furrowDepth: 0.55,
  furrowStrength: 0.92,
  normalStrength: 11,
  palette: {
    fissure: [0.116, 0.098, 0.082],
    crown: [0.36, 0.324, 0.27],
    fresh: [0.4, 0.35, 0.28],
    lichen: [0.52, 0.52, 0.46],
    moss: [0.2, 0.26, 0.15],
  },
}

/**
 * Rainbow eucalyptus: bark shed in ribbons, exposing streaks of green, blue,
 * orange and maroon that age through the whole sequence. Almost no fissuring —
 * the colour *is* the material, so the plate network stays nearly flat and the
 * palette does all the work.
 */
const RAINBOW_PEELING: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 7,
  plateAspect: 9,
  linkFrequency: [4, 9],
  minorFrequency: [20, 40],
  plateCyclesY: 3,
  furrowHalfWidth: 0.11,
  linkHalfWidth: 0.16,
  furrowDepth: 0.15,
  furrowStrength: 0.5,
  normalStrength: 5,
  palette: {
    fissure: [0.2, 0.3, 0.24],
    crown: [0.56, 0.44, 0.29],
    fresh: [0.3, 0.42, 0.35],
    lichen: [0.44, 0.36, 0.42],
    moss: [0.2, 0.34, 0.26],
  },
}

/** Gum eucalyptus: smooth, shedding in patches, mottled grey-cream-tan. */
const GUM_MOTTLED: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 5,
  plateAspect: 3.5,
  linkFrequency: [4, 8],
  minorFrequency: [16, 32],
  plateCyclesY: 4,
  furrowHalfWidth: 0.08,
  linkHalfWidth: 0.14,
  furrowDepth: 0.13,
  furrowStrength: 0.42,
  normalStrength: 4.5,
  palette: {
    fissure: [0.34, 0.315, 0.27],
    crown: [0.6, 0.585, 0.53],
    fresh: [0.5, 0.44, 0.35],
    lichen: [0.62, 0.62, 0.56],
    moss: [0.24, 0.3, 0.2],
  },
}

/** Giant sequoia: very thick, soft, deeply furrowed, strongly cinnamon-red. */
const FIBROUS_SEQUOIA: BarkProfile = {
  family: 'resinous-conifer',
  columns: 8,
  plateAspect: 6.5,
  linkFrequency: [6, 10],
  minorFrequency: [38, 76],
  plateCyclesY: 4,
  furrowHalfWidth: 0.2,
  linkHalfWidth: 0.16,
  furrowDepth: 0.62,
  furrowStrength: 0.95,
  normalStrength: 12,
  palette: {
    fissure: [0.135, 0.082, 0.058],
    crown: [0.47, 0.29, 0.2],
    fresh: [0.54, 0.33, 0.21],
    lichen: [0.5, 0.48, 0.42],
    moss: [0.2, 0.26, 0.14],
  },
}

/** Beech: famously smooth pale grey, with fine horizontal lenticel bands. */
const BEECH_SMOOTH: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 4,
  plateAspect: 0.9,
  linkFrequency: [3, 22],
  minorFrequency: [12, 24],
  plateCyclesY: 18,
  furrowHalfWidth: 0.05,
  linkHalfWidth: 0.06,
  furrowDepth: 0.09,
  furrowStrength: 0.3,
  normalStrength: 4,
  palette: {
    fissure: [0.4, 0.4, 0.38],
    crown: [0.62, 0.62, 0.58],
    fresh: [0.58, 0.57, 0.52],
    lichen: [0.64, 0.65, 0.58],
    moss: [0.26, 0.32, 0.21],
  },
}

/**
 * Silver birch: white, papery, peeling in horizontal strips, with black
 * diamond-shaped fissures at the branch scars. The horizontal grain is the
 * whole identity, so the plate cells are wider than they are tall.
 */
const BIRCH_WHITE: BarkProfile = {
  family: 'fissured-hardwood',
  columns: 3,
  plateAspect: 0.28,
  linkFrequency: [3, 40],
  minorFrequency: [10, 46],
  plateCyclesY: 30,
  furrowHalfWidth: 0.06,
  linkHalfWidth: 0.1,
  furrowDepth: 0.22,
  furrowStrength: 0.75,
  normalStrength: 6,
  palette: {
    fissure: [0.13, 0.125, 0.12],
    crown: [0.82, 0.815, 0.79],
    fresh: [0.72, 0.7, 0.66],
    lichen: [0.7, 0.71, 0.65],
    moss: [0.26, 0.32, 0.2],
  },
}

/** Cedar of Lebanon: dark grey-brown, finely and densely fissured. */
const CONIFER_FISSURED: BarkProfile = {
  family: 'resinous-conifer',
  columns: 28,
  plateAspect: 2.2,
  linkFrequency: [8, 38],
  minorFrequency: [44, 88],
  plateCyclesY: 10,
  furrowHalfWidth: 0.11,
  linkHalfWidth: 0.22,
  furrowDepth: 0.5,
  furrowStrength: 0.9,
  normalStrength: 10,
  palette: {
    fissure: [0.11, 0.098, 0.088],
    crown: [0.33, 0.315, 0.29],
    fresh: [0.37, 0.34, 0.3],
    lichen: [0.5, 0.5, 0.45],
    moss: [0.2, 0.26, 0.16],
  },
}

/** Japanese black pine: near-black plates split by deep grey-orange fissures. */
const PINE_PLATED_DARK: BarkProfile = {
  family: 'resinous-conifer',
  columns: 15,
  plateAspect: 1.9,
  linkFrequency: [7, 28],
  minorFrequency: [36, 72],
  plateCyclesY: 8,
  furrowHalfWidth: 0.15,
  linkHalfWidth: 0.2,
  furrowDepth: 0.6,
  furrowStrength: 0.95,
  normalStrength: 12,
  palette: {
    fissure: [0.28, 0.18, 0.12],
    crown: [0.24, 0.215, 0.19],
    fresh: [0.32, 0.27, 0.22],
    lichen: [0.46, 0.46, 0.42],
    moss: [0.19, 0.25, 0.15],
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
  'conifer-plated': RESINOUS_CONIFER,
  'conifer-scaled': RESINOUS_CONIFER,
  // A buttressed tropical bole is smoother and greyer than an oak, with far
  // shallower fissuring; the smooth profile is much closer than the oak one.
  'tropical-buttressed': SMOOTH_MOTTLED,
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
