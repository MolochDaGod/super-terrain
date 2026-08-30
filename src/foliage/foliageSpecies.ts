import { Vector4 } from 'three/webgpu'

/**
 * The ground-cover palette a brush can lay down.
 *
 * These are not eight variations on one lawn. A meadow reads as real because
 * several unrelated growth habits share the same square metre: fine soft
 * blades, a coarse arching tussock that breaks the height silhouette, a
 * broadleaf mat that fills the floor, a dry straw component that supplies the
 * warm hue nothing else has. Painting a single species anywhere always looks
 * like a texture; painting three overlapping ones looks like ground.
 */
export type FoliageSpeciesId =
  | 'meadow-fescue'
  | 'tussock'
  | 'dry-steppe'
  | 'clover-mat'
  | 'broadleaf-weed'
  | 'woodland-fern'
  | 'wildflower'
  | 'sedge-reed'
  | 'forest-moss'
  | 'wood-rush'
  | 'bramble'
  | 'bracken'

export interface FoliageSpecies {
  id: FoliageSpeciesId
  label: string
  /** Short authoring note shown in the toolbar tooltip. */
  hint: string
  /** UI swatch, in the same family as the shaded result. */
  swatch: string

  /** Metres, before per-blade variance. */
  height: number
  /** Fraction of `height` the per-blade random walk spans. */
  heightVariance: number
  /** Metres at the widest point of a blade. */
  width: number
  /**
   * Resistance to wind. 1 is a stiff reed that barely moves, 0 a limp blade
   * that lies over in a gust.
   */
  stiffness: number
  /** Radians of resting arc from base to tip with no wind at all. */
  arch: number
  /** Metres the blades of one clump scatter from its centre. */
  clumpRadius: number
  /**
   * Width profile exponent. High values taper to a needle point (grasses),
   * low values hold width most of the way (broadleaf).
   */
  taper: number
  /** Mid-blade widening. This is what turns a strip into a leaf. */
  bulge: number
  /** Radians the individual blades of a clump fan away from its axis. */
  yawSpread: number
  /** Radians of outward tilt at the base — an open rosette versus a tight tuft. */
  tiltSpread: number

  /** Linear-space colour at the sheath. */
  base: readonly [number, number, number]
  /** Linear-space colour at the tip, before drying. */
  tip: readonly [number, number, number]
  /** Linear-space colour of the flower or seed head, when one occurs. */
  flower: readonly [number, number, number]
  /** Fraction of blades that carry a head. */
  flowerChance: number
  /** Fraction of blades that have gone over to straw. */
  dryChance: number

  roughness: number
  /** How much light passes straight through the blade. Drives the backlit look. */
  translucency: number
  /**
   * Relative clump count. A fern colony is sparse and large; a lawn is dense
   * and small, and both have to feel right at the same brush density.
   */
  densityScale: number
  /** Blades drawn per clump at the closest level of detail. */
  bladesPerClump: number

  /**
   * How much of the species' abundance is decided by *where* rather than by
   * how much was painted, 0..1.
   *
   * The paint mask has a 0.78-metre cell, which is a fine resolution for
   * saying where a fern colony is and a useless one for saying what the ground
   * looks like between the ferns. Left at zero, a painted weight of 0.6 means
   * every square metre of the stroke carries six tenths of the plants it could
   * — an even thinning, which is the single most recognisable tell that a
   * floor was scattered rather than grown. At one the same weight means the
   * plant is absent from most of the stroke and continuous in the patches it
   * did take, which is what a colony actually is.
   *
   * Mats are near zero: moss and clover really do cover the ground evenly
   * wherever they cover it at all. Everything that spreads from a rootstock —
   * bracken, bramble, fern — is high.
   */
  clumping: number
  /**
   * Metres across the patches that clumping carves, roughly.
   *
   * A bracken stand is tens of metres; a tussock's ground is a couple. Getting
   * this wrong in either direction is what makes procedural scatter look
   * procedural: one scale for everything gives the whole floor the same
   * blotchiness whatever is growing on it.
   */
  patchScale: number
}

export const FOLIAGE_SPECIES: readonly FoliageSpecies[] = [
  {
    id: 'meadow-fescue',
    label: 'Meadow fescue',
    hint: 'Fine soft pasture grass · the default floor',
    swatch: '#6f9a4a',
    height: 0.34,
    heightVariance: 0.42,
    width: 0.0075,
    stiffness: 0.34,
    arch: 0.62,
    clumpRadius: 0.075,
    taper: 1.35,
    bulge: 0.1,
    yawSpread: 2.6,
    tiltSpread: 0.42,
    base: [0.055, 0.085, 0.028],
    tip: [0.155, 0.215, 0.062],
    flower: [0.19, 0.2, 0.11],
    flowerChance: 0.05,
    dryChance: 0.13,
    roughness: 0.62,
    translucency: 0.78,
    densityScale: 1,
    bladesPerClump: 6,
    clumping: 0.18,
    patchScale: 9,
  },
  {
    id: 'tussock',
    label: 'Tussock',
    hint: 'Coarse arching bunchgrass · breaks the skyline',
    swatch: '#8aa86a',
    height: 0.82,
    heightVariance: 0.34,
    width: 0.0115,
    stiffness: 0.55,
    arch: 1.25,
    clumpRadius: 0.13,
    taper: 1.7,
    bulge: 0.06,
    yawSpread: 3.1,
    tiltSpread: 0.72,
    base: [0.062, 0.078, 0.03],
    tip: [0.19, 0.216, 0.09],
    flower: [0.24, 0.21, 0.12],
    flowerChance: 0.22,
    dryChance: 0.3,
    roughness: 0.58,
    translucency: 0.72,
    densityScale: 0.42,
    bladesPerClump: 7,
    clumping: 0.55,
    patchScale: 6,
  },
  {
    id: 'dry-steppe',
    label: 'Dry steppe',
    hint: 'Sun-bleached bent grass · warm straw hue',
    swatch: '#c2a35c',
    height: 0.48,
    heightVariance: 0.5,
    width: 0.006,
    stiffness: 0.28,
    arch: 1.05,
    clumpRadius: 0.1,
    taper: 1.9,
    bulge: 0.04,
    yawSpread: 3.0,
    tiltSpread: 0.6,
    base: [0.105, 0.098, 0.042],
    tip: [0.34, 0.29, 0.128],
    flower: [0.42, 0.36, 0.19],
    flowerChance: 0.4,
    dryChance: 0.82,
    roughness: 0.72,
    translucency: 0.9,
    densityScale: 0.72,
    bladesPerClump: 6,
    clumping: 0.42,
    patchScale: 14,
  },
  {
    id: 'clover-mat',
    label: 'Clover mat',
    hint: 'Low broadleaf ground cover · fills the floor',
    swatch: '#4f7a3a',
    height: 0.115,
    heightVariance: 0.3,
    width: 0.031,
    stiffness: 0.6,
    arch: 0.34,
    clumpRadius: 0.055,
    taper: 0.22,
    bulge: 0.85,
    yawSpread: 3.14,
    tiltSpread: 0.95,
    base: [0.03, 0.055, 0.018],
    tip: [0.075, 0.135, 0.038],
    flower: [0.5, 0.48, 0.4],
    flowerChance: 0.11,
    dryChance: 0.04,
    roughness: 0.5,
    translucency: 0.6,
    densityScale: 1.5,
    bladesPerClump: 5,
    clumping: 0.12,
    patchScale: 5,
  },
  {
    id: 'broadleaf-weed',
    label: 'Broadleaf weed',
    hint: 'Ribbed plantain rosette · coarse silhouette break',
    swatch: '#5c8340',
    height: 0.23,
    heightVariance: 0.36,
    width: 0.045,
    stiffness: 0.72,
    arch: 0.5,
    clumpRadius: 0.03,
    taper: 0.45,
    bulge: 0.62,
    yawSpread: 3.14,
    tiltSpread: 1.15,
    base: [0.034, 0.052, 0.02],
    tip: [0.098, 0.146, 0.046],
    flower: [0.2, 0.19, 0.1],
    flowerChance: 0.18,
    dryChance: 0.08,
    roughness: 0.55,
    translucency: 0.55,
    densityScale: 0.4,
    bladesPerClump: 5,
    clumping: 0.5,
    patchScale: 4,
  },
  {
    id: 'woodland-fern',
    label: 'Woodland fern',
    hint: 'Shade understory frond · deep cool green',
    swatch: '#3f6b3c',
    height: 0.55,
    heightVariance: 0.3,
    // Narrower and sharper than it was, and the reason is what a blade in this
    // system actually stands for. A fern frond is twice-divided — a rachis
    // carrying thirty pinnae — and there is no geometry here to build that
    // from, so the honest thing for one blade to represent is one *pinna*, not
    // the whole frond. At six centimetres wide with a low taper it was a broad
    // rounded paddle, and six of them in a clump read as an agave. At three
    // centimetres with a real taper the same six read as a divided frond.
    width: 0.03,
    stiffness: 0.66,
    arch: 0.95,
    clumpRadius: 0.07,
    taper: 1.4,
    bulge: 0.28,
    yawSpread: 3.14,
    tiltSpread: 0.9,
    base: [0.022, 0.045, 0.02],
    tip: [0.062, 0.115, 0.045],
    flower: [0.08, 0.12, 0.05],
    flowerChance: 0,
    dryChance: 0.06,
    roughness: 0.44,
    translucency: 0.68,
    densityScale: 0.3,
    bladesPerClump: 6,
    clumping: 0.72,
    patchScale: 7,
  },
  {
    id: 'wildflower',
    label: 'Wildflower',
    hint: 'Mixed sward with flower heads · colour accents',
    swatch: '#b8c46a',
    height: 0.42,
    heightVariance: 0.45,
    width: 0.008,
    stiffness: 0.4,
    arch: 0.55,
    clumpRadius: 0.11,
    taper: 1.4,
    bulge: 0.12,
    yawSpread: 3.0,
    tiltSpread: 0.55,
    base: [0.05, 0.08, 0.028],
    tip: [0.16, 0.215, 0.07],
    flower: [0.62, 0.52, 0.2],
    flowerChance: 0.34,
    dryChance: 0.12,
    roughness: 0.6,
    translucency: 0.8,
    densityScale: 0.8,
    bladesPerClump: 6,
    clumping: 0.46,
    patchScale: 8,
  },
  {
    id: 'sedge-reed',
    label: 'Sedge & reed',
    hint: 'Tall stiff wetland blades · vertical accent',
    swatch: '#6d9b78',
    height: 1.15,
    heightVariance: 0.28,
    width: 0.014,
    stiffness: 0.86,
    arch: 0.42,
    clumpRadius: 0.09,
    taper: 1.15,
    bulge: 0.08,
    yawSpread: 2.2,
    tiltSpread: 0.3,
    base: [0.04, 0.072, 0.038],
    tip: [0.12, 0.192, 0.098],
    flower: [0.13, 0.1, 0.07],
    flowerChance: 0.16,
    dryChance: 0.1,
    roughness: 0.4,
    translucency: 0.62,
    densityScale: 0.32,
    bladesPerClump: 7,
    clumping: 0.66,
    patchScale: 11,
  },
  // The woodland floor. The set above was written for open ground, and a stand
  // painted with it reads as a lawn under trees: everything in it sits between
  // ten and sixty centimetres, and nothing has the habit of a shade plant. The
  // four below are the layers a real forest floor is actually built from, and
  // they are chosen for the lengths the palette had nothing at — a mat below
  // everything, and a frond above everything.
  {
    id: 'forest-moss',
    label: 'Forest moss',
    hint: 'Ground-hugging mat · damp saturated green',
    swatch: '#4a7a3a',
    // Ankle height is already too tall. Moss is the layer that makes a floor
    // read as old and damp rather than as bare soil with plants standing on
    // it, and it only does that by being genuinely flat.
    height: 0.045,
    heightVariance: 0.55,
    width: 0.005,
    // It does not move. A moss that sways in the wind is the single most
    // obvious way this layer announces it is made of grass blades.
    stiffness: 0.96,
    arch: 0.45,
    clumpRadius: 0.055,
    taper: 0.95,
    bulge: 0.34,
    yawSpread: 3.14,
    // Splayed almost flat, which is what turns a tuft into a cushion.
    tiltSpread: 1.25,
    base: [0.016, 0.038, 0.014],
    tip: [0.055, 0.105, 0.03],
    flower: [0.07, 0.1, 0.04],
    flowerChance: 0,
    dryChance: 0.02,
    roughness: 0.74,
    translucency: 0.32,
    // Dense: a mat is continuous or it is not a mat.
    densityScale: 2.4,
    bladesPerClump: 8,
    clumping: 0.22,
    patchScale: 3.5,
  },
  {
    id: 'wood-rush',
    label: 'Wood rush',
    hint: 'Fine arching tufts · pale fresh green',
    swatch: '#7fa356',
    height: 0.26,
    heightVariance: 0.42,
    width: 0.005,
    stiffness: 0.42,
    arch: 0.88,
    clumpRadius: 0.062,
    taper: 1.5,
    bulge: 0.06,
    yawSpread: 2.7,
    tiltSpread: 0.72,
    base: [0.038, 0.062, 0.026],
    tip: [0.125, 0.175, 0.062],
    flower: [0.16, 0.14, 0.08],
    flowerChance: 0.1,
    dryChance: 0.16,
    roughness: 0.52,
    translucency: 0.72,
    densityScale: 0.95,
    bladesPerClump: 7,
    clumping: 0.4,
    patchScale: 5,
  },
  {
    id: 'bramble',
    label: 'Bramble',
    hint: 'Sprawling dark canes · broad leaves',
    swatch: '#2f4a2c',
    height: 0.52,
    heightVariance: 0.45,
    // Broad enough to read as a leaf rather than a blade, which is what the
    // floor needs between the grasses and the ferns. Bramble keeps its width
    // where the ferns lost theirs: its leaflets really are palm-sized entire
    // blades, so one blade standing for one leaflet is the right model.
    width: 0.058,
    stiffness: 0.48,
    // A cane arches over and back down. This is the parameter that makes it
    // sprawl instead of stand.
    arch: 1.28,
    clumpRadius: 0.17,
    taper: 0.5,
    bulge: 0.62,
    yawSpread: 3.14,
    tiltSpread: 1.05,
    base: [0.014, 0.03, 0.014],
    tip: [0.055, 0.088, 0.032],
    flower: [0.1, 0.06, 0.07],
    flowerChance: 0.06,
    dryChance: 0.1,
    roughness: 0.38,
    translucency: 0.48,
    densityScale: 0.34,
    bladesPerClump: 6,
    clumping: 0.78,
    patchScale: 6,
  },
  {
    id: 'bracken',
    label: 'Bracken',
    hint: 'Waist-high arching fronds · the tall layer',
    swatch: '#5c7a3a',
    // The one the palette was missing most. A metre of frond is what stops a
    // forest floor reading as mown, and nothing else in the set reaches it
    // except the sedge, which is a wetland plant standing bolt upright.
    height: 1.02,
    heightVariance: 0.36,
    // Same correction as the woodland fern's, and it mattered more here: at
    // ten and a half centimetres across and a metre tall, a bracken blade was
    // the largest single primitive anywhere on the floor, and a stand of them
    // filled the lower half of every eye-level frame with what looked like a
    // field of agave. One blade is one pinna of a frond.
    width: 0.045,
    stiffness: 0.52,
    arch: 1.02,
    clumpRadius: 0.1,
    taper: 1.5,
    bulge: 0.3,
    yawSpread: 3.14,
    tiltSpread: 0.88,
    base: [0.02, 0.042, 0.018],
    tip: [0.075, 0.13, 0.042],
    flower: [0.1, 0.09, 0.04],
    flowerChance: 0,
    // Bracken browns off in patches, and the dead fronds stay standing.
    dryChance: 0.2,
    roughness: 0.42,
    translucency: 0.74,
    // Sparse and large, like the fern it is.
    densityScale: 0.24,
    bladesPerClump: 5,
    clumping: 0.8,
    patchScale: 16,
  },
]

export const FOLIAGE_SPECIES_COUNT = FOLIAGE_SPECIES.length

/**
 * vec4 rows of species weight the paint mask carries per cell.
 *
 * Everything that reads or writes the mask derives its row count from this
 * rather than assuming two, so adding a species is an edit to the list above
 * and nothing else.
 */
export const FOLIAGE_MASK_ROWS = Math.ceil(FOLIAGE_SPECIES_COUNT / 4)

export function foliageSpeciesIndex(id: FoliageSpeciesId): number {
  const index = FOLIAGE_SPECIES.findIndex((species) => species.id === id)
  return index < 0 ? 0 : index
}

/** Rows per species in the packed uniform table. */
export const FOLIAGE_SPECIES_STRIDE = 7

/**
 * The species table as the shaders see it.
 *
 * One `uniformArray` indexed by a species number is what lets every painted
 * type share a single draw call. The alternative — a material per species —
 * multiplies both the draw count and the number of pipelines that have to be
 * compiled before the first frame, for no visual gain: the differences are all
 * numbers a shader can read.
 */
export function packFoliageSpecies(
  species: readonly FoliageSpecies[] = FOLIAGE_SPECIES,
): Vector4[] {
  const rows: Vector4[] = []
  for (const entry of species) {
    rows.push(
      new Vector4(entry.height, entry.heightVariance, entry.width, entry.stiffness),
      new Vector4(entry.arch, entry.clumpRadius, entry.taper, entry.bulge),
      new Vector4(entry.base[0], entry.base[1], entry.base[2], entry.roughness),
      new Vector4(entry.tip[0], entry.tip[1], entry.tip[2], entry.translucency),
      new Vector4(
        entry.flower[0],
        entry.flower[1],
        entry.flower[2],
        entry.flowerChance,
      ),
      new Vector4(
        entry.dryChance,
        entry.yawSpread,
        entry.tiltSpread,
        entry.densityScale,
      ),
      new Vector4(entry.clumping, entry.patchScale, 0, 0),
    )
  }
  return rows
}

/**
 * What one species looks like when you cannot resolve its blades any more.
 *
 * Averaged from the same sheath and tip colours the blade material shades with,
 * so any surface that falls back to an aggregate — the ground canopy in the
 * tree lab, the terrain material under a forest — is the same green the near
 * field is made of. Drift between the two shows up as a visible ring on the
 * ground at the range where the last instanced blades give out.
 */
export const AGGREGATE_COLOURS = FOLIAGE_SPECIES.map((species) => [
  species.base[0] * 0.4 + species.tip[0] * 0.6,
  species.base[1] * 0.4 + species.tip[1] * 0.6,
  species.base[2] * 0.4 + species.tip[2] * 0.6,
] as const)

/**
 * Scale the packed sward colour is stored at.
 *
 * The aggregate greens are dark — a tenth to a third of full scale — and the
 * summary texture is eight bits a channel, so storing them raw spends a quarter
 * of the available codes on the whole range anyone will see. Scaling up before
 * the store and back down after it buys two bits for one multiply.
 */
export const SWARD_COLOUR_SCALE = 3
