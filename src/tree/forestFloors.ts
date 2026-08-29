import type { FoliageFloorRecipe } from '../foliage/foliageFloor'
import type { ForestPresetId } from './forestPresets'

/**
 * The floor each forest preset grows on.
 *
 * A stand's ground is as much a part of what it is as its canopy, and until
 * now every preset in the editor opened on the same one: deep broadleaf litter
 * with bracken, fern, bramble and wood rush on it. Under a spruce plantation
 * that is wrong in every particular — the floor there is a fine, even, almost
 * black felt of needles that suppresses nearly everything, with moss where the
 * light gets in. On a savanna it is dry earth and bleached bunchgrass. Getting
 * the floor wrong costs more than getting the trees wrong, because the floor is
 * most of the lower half of every eye-level frame.
 *
 * Three tiers in each, deliberately, because that is the structure a real
 * ground cover has and the one thing a single painted species can never
 * produce:
 *
 *   - the surface itself — litter, duff, moss film, bare earth,
 *   - a low mat that runs continuously over it,
 *   - a mid layer of grasses, ferns and herbs standing in it,
 *   - and a sparse tall layer that breaks the silhouette above both.
 *
 * The counts are colonies, not plants. Each one becomes a soft brush dab at
 * well under full flow, so they overlap into genuine mixtures with incomplete
 * edges instead of stacking as decals.
 */

/** How far colonies scatter. The world ground is four hundred metres across. */
const SPREAD = 124

export const FOREST_FLOORS: Record<ForestPresetId, FoliageFloorRecipe> = {
  // Deep shade, permanent damp, and the richest floor in the catalogue.
  'mossy-old-growth': {
    id: 'mossy-old-growth',
    label: 'Mossy beech floor',
    // Damp humus: dark, warm, and well under the mineral ground's own value.
    soilTint: [0.3, 0.255, 0.205],
    surfaces: [
      { surface: 'leaf-litter', fill: 0.88 },
      {
        surface: 'ground-moss',
        // The name of the preset. Moss here is not an accent, it is most of
        // what the floor is: over the litter, over the roots, over the logs.
        fill: 0.34,
        count: 26,
        spread: SPREAD,
        radius: [10, 30],
        flow: [0.45, 0.85],
        seed: 0x9a11,
      },
      {
        surface: 'bare-earth',
        count: 12,
        spread: SPREAD,
        radius: [3, 9],
        flow: [0.35, 0.7],
        seed: 0xb307,
      },
    ],
    colonies: [
      // Washes first, then colonies on top of them.
      //
      // The wash weights are not the shares you see. The population kernel
      // multiplies each species' painted weight by its own `densityScale`
      // before drawing from the mix, and those run from 0.24 for bracken to
      // 2.4 for moss — a tenfold spread, because a bracken clump is a metre of
      // frond and a moss clump is a cushion. So a wash of 0.5 bracken and 0.5
      // moss is not half and half; it is one part bracken to ten parts moss.
      //
      // Getting that backwards is what the first version of this did. It laid
      // a moss wash at 0.34 and a rush wash at 0.3 and left everything else to
      // colonies, which measured out as a floor that was 58 per cent moss and
      // 33 per cent rush by clump — and moss is four and a half centimetres
      // tall. Eighty-five per cent of the ground had a plant on it and the
      // ground still read as bare, because almost none of those plants had any
      // height. The numbers below are solved backwards from the shares wanted:
      // `weight = share / densityScale`.
      //
      // The tall tiers are barely in the wash at all. Bracken and fern belong
      // to their colonies: a wash strong enough to see everywhere is a wash
      // that puts waist-high fronds over every square metre of the stand, and
      // a floor you cannot see through is not a forest floor, it is a hedge
      // laid flat. The wash is there so the colonies have something to fade
      // into at their edges, not to carry the layer.
      //
      // Moss is nearly absent from this list on purpose. It is a film, not a
      // stand of individuals, and it lives in the ground layer where a film
      // belongs; what little is here is the cushion on a rotting log.
      { species: 'meadow-fescue', count: 1, spread: 0, radius: [600, 600], flow: [0.34, 0.34], seed: 0x10 },
      { species: 'wood-rush', count: 1, spread: 0, radius: [600, 600], flow: [0.22, 0.22], seed: 0x11 },
      { species: 'woodland-fern', count: 1, spread: 0, radius: [600, 600], flow: [0.12, 0.12], seed: 0x12 },
      { species: 'bracken', count: 1, spread: 0, radius: [600, 600], flow: [0.07, 0.07], seed: 0x13 },
      { species: 'clover-mat', count: 1, spread: 0, radius: [600, 600], flow: [0.16, 0.16], seed: 0x14 },
      { species: 'bramble', count: 1, spread: 0, radius: [600, 600], flow: [0.08, 0.08], seed: 0x15 },
      // Low: wood sorrel in the damper hollows, moss cushions on the deadfall,
      // a fine rush threading between everything.
      { species: 'clover-mat', count: 20, spread: 128, radius: [8, 20], flow: [0.24, 0.4], seed: 0x6e41 },
      { species: 'forest-moss', count: 16, spread: 128, radius: [6, 15], flow: [0.1, 0.2], seed: 0x6e40 },
      { species: 'wood-rush', count: 30, spread: 130, radius: [12, 25], flow: [0.28, 0.46], seed: 0x4d63 },
      // Mid: fern colonies in the shade, herbs as the exception rather than
      // the rule — painted at full flow these read as pale plastic leaves.
      { species: 'woodland-fern', count: 26, spread: 118, radius: [10, 20], flow: [0.4, 0.66], seed: 0x2c71 },
      { species: 'broadleaf-weed', count: 18, spread: 120, radius: [11, 19], flow: [0.16, 0.28], seed: 0x5b87 },
      // Tall: bracken over the open ground, bramble where a gap lets light in.
      { species: 'bracken', count: 22, spread: 122, radius: [11, 23], flow: [0.4, 0.7], seed: 0x1f35 },
      { species: 'bramble', count: 16, spread: 116, radius: [6, 14], flow: [0.34, 0.6], seed: 0x3a19 },
    ],
    breaks: {
      count: 46,
      spread: SPREAD,
      radius: [2.5, 9],
      strength: [0.6, 1],
      bareEarth: 0.5,
      seed: 0xc41d,
    },
  },

  // Open enough for a real sward between the stems.
  'temperate-mixed': {
    id: 'temperate-mixed',
    label: 'Mixed woodland floor',
    soilTint: [0.42, 0.365, 0.29],
    surfaces: [
      { surface: 'leaf-litter', fill: 0.7 },
      { surface: 'ground-moss', fill: 0.14, count: 14, spread: SPREAD, radius: [8, 20], flow: [0.3, 0.6], seed: 0x1177 },
      { surface: 'bare-earth', count: 16, spread: SPREAD, radius: [3, 10], flow: [0.4, 0.75], seed: 0x2288 },
    ],
    colonies: [
      // A wash per tier, solved backwards from the share wanted: the kernel
      // weights a painted value by the species' own `densityScale` before it
      // draws, and those run over a tenfold range. An open mixed wood has a
      // real sward under it, so the fine grass carries most of the floor.
      { species: 'meadow-fescue', count: 1, spread: 0, radius: [600, 600], flow: [0.45, 0.45], seed: 0x30 },
      { species: 'clover-mat', count: 1, spread: 0, radius: [600, 600], flow: [0.12, 0.12], seed: 0x31 },
      { species: 'woodland-fern', count: 1, spread: 0, radius: [600, 600], flow: [0.3, 0.3], seed: 0x32 },
      { species: 'bracken', count: 1, spread: 0, radius: [600, 600], flow: [0.3, 0.3], seed: 0x33 },
      { species: 'bramble', count: 1, spread: 0, radius: [600, 600], flow: [0.25, 0.25], seed: 0x34 },
      { species: 'clover-mat', count: 20, spread: SPREAD, radius: [8, 20], flow: [0.25, 0.45], seed: 0x3311 },
      { species: 'meadow-fescue', count: 22, spread: SPREAD, radius: [14, 32], flow: [0.3, 0.5], seed: 0x4422 },
      { species: 'woodland-fern', count: 16, spread: SPREAD, radius: [8, 17], flow: [0.3, 0.5], seed: 0x5533 },
      { species: 'broadleaf-weed', count: 20, spread: SPREAD, radius: [9, 18], flow: [0.2, 0.36], seed: 0x6644 },
      { species: 'bramble', count: 18, spread: SPREAD, radius: [7, 15], flow: [0.3, 0.52], seed: 0x7755 },
      { species: 'bracken', count: 12, spread: SPREAD, radius: [9, 20], flow: [0.24, 0.44], seed: 0x8866 },
    ],
    breaks: {
      count: 30,
      spread: SPREAD,
      radius: [2.5, 8],
      strength: [0.5, 0.9],
      bareEarth: 0.7,
      seed: 0x9977,
    },
  },

  // Wood pasture: grazed turf under widely spaced veterans.
  'ancient-oak-grove': {
    id: 'ancient-oak-grove',
    label: 'Wood pasture floor',
    soilTint: [0.58, 0.53, 0.42],
    surfaces: [
      { surface: 'leaf-litter', fill: 0.3, count: 20, spread: SPREAD, radius: [7, 18], flow: [0.35, 0.7], seed: 0xa101 },
      { surface: 'bare-earth', fill: 0.16, count: 22, spread: SPREAD, radius: [3, 11], flow: [0.4, 0.8], seed: 0xa202 },
    ],
    colonies: [
      { species: 'clover-mat', count: 24, spread: SPREAD, radius: [14, 34], flow: [0.4, 0.65], seed: 0xa303 },
      { species: 'meadow-fescue', count: 26, spread: SPREAD, radius: [22, 48], flow: [0.45, 0.7], seed: 0xa404 },
      { species: 'tussock', count: 16, spread: SPREAD, radius: [10, 26], flow: [0.3, 0.5], seed: 0xa505 },
      { species: 'wildflower', count: 14, spread: SPREAD, radius: [10, 24], flow: [0.25, 0.45], seed: 0xa606 },
      { species: 'bracken', count: 14, spread: SPREAD, radius: [10, 24], flow: [0.3, 0.55], seed: 0xa707 },
    ],
    breaks: {
      count: 26,
      spread: SPREAD,
      radius: [3, 10],
      strength: [0.5, 0.9],
      bareEarth: 0.85,
      seed: 0xa808,
    },
  },

  // Needle felt, moss, and almost nothing else. Acid, dark and suppressed.
  'boreal-conifer': {
    id: 'boreal-conifer',
    label: 'Boreal needle floor',
    soilTint: [0.26, 0.235, 0.2],
    surfaces: [
      { surface: 'needle-duff', fill: 0.92 },
      {
        surface: 'ground-moss',
        fill: 0.42,
        count: 30,
        spread: SPREAD,
        radius: [12, 34],
        flow: [0.5, 0.9],
        seed: 0xb111,
      },
      { surface: 'bare-earth', count: 8, spread: SPREAD, radius: [2.5, 7], flow: [0.3, 0.6], seed: 0xb222 },
    ],
    colonies: [
      // A boreal floor is genuinely sparser than a beech one, but the first
      // version of this was not sparse — it was empty. Measured over the stand
      // interior its mean cover came to 0.03, which is three plants in a
      // hundred square metres. What actually carries a spruce floor is a low
      // ericaceous shrub layer over the moss: bilberry, cowberry, crowberry,
      // ankle to knee high and close to continuous where the light gets in.
      // `bramble` is the palette's only sprawling low shrub, so it stands in.
      { species: 'bramble', count: 1, spread: 0, radius: [600, 600], flow: [0.34, 0.34], seed: 0x20 },
      { species: 'wood-rush', count: 1, spread: 0, radius: [600, 600], flow: [0.22, 0.22], seed: 0x21 },
      { species: 'woodland-fern', count: 1, spread: 0, radius: [600, 600], flow: [0.2, 0.2], seed: 0x22 },
      { species: 'bramble', count: 24, spread: SPREAD, radius: [10, 24], flow: [0.4, 0.7], seed: 0xb555 },
      { species: 'wood-rush', count: 22, spread: SPREAD, radius: [10, 22], flow: [0.24, 0.42], seed: 0xb333 },
      { species: 'woodland-fern', count: 14, spread: SPREAD, radius: [7, 16], flow: [0.34, 0.58], seed: 0xb444 },
      { species: 'forest-moss', count: 20, spread: SPREAD, radius: [8, 20], flow: [0.12, 0.24], seed: 0xb777 },
    ],
    breaks: {
      count: 22,
      spread: SPREAD,
      radius: [2, 6],
      strength: [0.45, 0.8],
      bareEarth: 0.4,
      seed: 0xb666,
    },
  },

  // Redwood duff: deep, red-brown, and famously bare between the sorrel beds.
  'primeval-redwood': {
    id: 'primeval-redwood',
    label: 'Redwood duff floor',
    soilTint: [0.28, 0.225, 0.18],
    surfaces: [
      { surface: 'needle-duff', fill: 0.86 },
      { surface: 'leaf-litter', count: 14, spread: SPREAD, radius: [8, 20], flow: [0.3, 0.55], seed: 0xc111 },
      { surface: 'ground-moss', fill: 0.24, count: 20, spread: SPREAD, radius: [10, 26], flow: [0.4, 0.75], seed: 0xc222 },
    ],
    colonies: [
      // Redwood sorrel is the floor of a coast redwood grove — a continuous
      // clover-leaved carpet — with sword fern standing out of it.
      { species: 'clover-mat', count: 1, spread: 0, radius: [600, 600], flow: [0.28, 0.28], seed: 0x40 },
      { species: 'woodland-fern', count: 1, spread: 0, radius: [600, 600], flow: [0.7, 0.7], seed: 0x41 },
      { species: 'bracken', count: 1, spread: 0, radius: [600, 600], flow: [0.35, 0.35], seed: 0x42 },
      { species: 'wood-rush', count: 1, spread: 0, radius: [600, 600], flow: [0.08, 0.08], seed: 0x43 },
      { species: 'clover-mat', count: 22, spread: SPREAD, radius: [10, 26], flow: [0.35, 0.6], seed: 0xc333 },
      { species: 'woodland-fern', count: 26, spread: SPREAD, radius: [10, 22], flow: [0.4, 0.65], seed: 0xc444 },
      { species: 'bracken', count: 12, spread: SPREAD, radius: [9, 20], flow: [0.25, 0.45], seed: 0xc555 },
    ],
    breaks: {
      count: 24,
      spread: SPREAD,
      radius: [3, 9],
      strength: [0.5, 0.9],
      bareEarth: 0.45,
      seed: 0xc666,
    },
  },

  // Wet tropics: everything rots too fast for a litter layer to build up.
  'tropical-wet': {
    id: 'tropical-wet',
    label: 'Wet tropical floor',
    soilTint: [0.3, 0.245, 0.185],
    surfaces: [
      { surface: 'leaf-litter', fill: 0.62 },
      { surface: 'ground-moss', fill: 0.3, count: 24, spread: SPREAD, radius: [9, 24], flow: [0.45, 0.85], seed: 0xd111 },
      { surface: 'bare-earth', count: 14, spread: SPREAD, radius: [3, 9], flow: [0.4, 0.75], seed: 0xd222 },
    ],
    colonies: [
      // Wet tropics: ferns everywhere, sedge in the seeps, and a sprawling
      // low tangle through both.
      { species: 'woodland-fern', count: 1, spread: 0, radius: [600, 600], flow: [0.8, 0.8], seed: 0x50 },
      { species: 'clover-mat', count: 1, spread: 0, radius: [600, 600], flow: [0.2, 0.2], seed: 0x51 },
      { species: 'sedge-reed', count: 1, spread: 0, radius: [600, 600], flow: [0.4, 0.4], seed: 0x52 },
      { species: 'bramble', count: 1, spread: 0, radius: [600, 600], flow: [0.5, 0.5], seed: 0x53 },
      { species: 'clover-mat', count: 20, spread: SPREAD, radius: [9, 22], flow: [0.3, 0.55], seed: 0xd333 },
      { species: 'woodland-fern', count: 30, spread: SPREAD, radius: [11, 24], flow: [0.45, 0.72], seed: 0xd444 },
      { species: 'sedge-reed', count: 14, spread: SPREAD, radius: [8, 18], flow: [0.25, 0.45], seed: 0xd555 },
      { species: 'bramble', count: 16, spread: SPREAD, radius: [7, 16], flow: [0.3, 0.55], seed: 0xd666 },
    ],
    breaks: {
      count: 26,
      spread: SPREAD,
      radius: [2.5, 8],
      strength: [0.5, 0.9],
      bareEarth: 0.6,
      seed: 0xd777,
    },
  },

  // Sand, litter under the palms, and reed where the water is.
  'palm-oasis': {
    id: 'palm-oasis',
    label: 'Oasis floor',
    soilTint: [0.86, 0.79, 0.64],
    surfaces: [
      { surface: 'bare-earth', fill: 0.78 },
      { surface: 'leaf-litter', count: 16, spread: 90, radius: [6, 16], flow: [0.35, 0.65], seed: 0xe111 },
    ],
    colonies: [
      // Thin: an oasis floor is mostly sand, and the wash only has to stop it
      // being sand with nothing on it at all.
      { species: 'dry-steppe', count: 1, spread: 0, radius: [600, 600], flow: [0.4, 0.4], seed: 0x60 },
      { species: 'sedge-reed', count: 1, spread: 0, radius: [600, 600], flow: [0.5, 0.5], seed: 0x61 },
      { species: 'tussock', count: 1, spread: 0, radius: [600, 600], flow: [0.25, 0.25], seed: 0x62 },
      { species: 'dry-steppe', count: 22, spread: SPREAD, radius: [14, 34], flow: [0.28, 0.5], seed: 0xe222 },
      { species: 'sedge-reed', count: 16, spread: 80, radius: [10, 24], flow: [0.4, 0.7], seed: 0xe333 },
      { species: 'tussock', count: 12, spread: SPREAD, radius: [9, 22], flow: [0.25, 0.45], seed: 0xe444 },
    ],
    breaks: {
      count: 30,
      spread: SPREAD,
      radius: [4, 14],
      strength: [0.6, 1],
      bareEarth: 1,
      seed: 0xe555,
    },
  },

  // Bleached bunchgrass over hard dry earth.
  savanna: {
    id: 'savanna',
    label: 'Savanna floor',
    soilTint: [0.82, 0.72, 0.56],
    surfaces: [
      { surface: 'bare-earth', fill: 0.62 },
      { surface: 'leaf-litter', count: 10, spread: SPREAD, radius: [5, 14], flow: [0.25, 0.45], seed: 0xf111 },
    ],
    colonies: [
      // Bunchgrass is near-continuous between the acacias; the bare ground is
      // in the trampled patches the breaks cut, not between every tuft.
      { species: 'dry-steppe', count: 1, spread: 0, radius: [600, 600], flow: [0.25, 0.25], seed: 0x70 },
      { species: 'dry-steppe', count: 30, spread: 140, radius: [26, 58], flow: [0.5, 0.75], seed: 0xf222 },
      { species: 'tussock', count: 22, spread: 140, radius: [12, 30], flow: [0.35, 0.6], seed: 0xf333 },
      { species: 'wildflower', count: 10, spread: 140, radius: [10, 24], flow: [0.18, 0.34], seed: 0xf444 },
      { species: 'broadleaf-weed', count: 10, spread: 140, radius: [7, 16], flow: [0.15, 0.28], seed: 0xf555 },
    ],
    breaks: {
      count: 34,
      spread: 140,
      radius: [4, 13],
      strength: [0.6, 1],
      bareEarth: 1,
      seed: 0xf666,
    },
  },

  // Stone, grit and the odd tuft in a hollow.
  'arid-woodland': {
    id: 'arid-woodland',
    label: 'Arid floor',
    soilTint: [0.78, 0.68, 0.55],
    surfaces: [
      { surface: 'bare-earth', fill: 0.88 },
      { surface: 'needle-duff', count: 8, spread: SPREAD, radius: [4, 12], flow: [0.2, 0.4], seed: 0x1a11 },
    ],
    colonies: [
      // Genuinely sparse, but not empty: tufts in the hollows where the last
      // rain collected.
      { species: 'dry-steppe', count: 1, spread: 0, radius: [600, 600], flow: [0.28, 0.28], seed: 0x80 },
      { species: 'tussock', count: 1, spread: 0, radius: [600, 600], flow: [0.3, 0.3], seed: 0x81 },
      { species: 'dry-steppe', count: 20, spread: 140, radius: [12, 30], flow: [0.28, 0.5], seed: 0x1a22 },
      { species: 'tussock', count: 16, spread: 140, radius: [8, 20], flow: [0.22, 0.42], seed: 0x1a33 },
    ],
    breaks: {
      count: 38,
      spread: 140,
      radius: [5, 16],
      strength: [0.7, 1],
      bareEarth: 1,
      seed: 0x1a44,
    },
  },
}

export function forestFloorRecipe(preset: ForestPresetId): FoliageFloorRecipe {
  return FOREST_FLOORS[preset] ?? FOREST_FLOORS['mossy-old-growth']
}
