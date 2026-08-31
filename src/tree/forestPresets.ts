import {
  TREE_SPECIES_PRESETS,
  type TreeSpecies,
} from './generator/types'

export type ForestPresetId =
  | 'mossy-old-growth'
  | 'temperate-mixed'
  | 'ancient-oak-grove'
  | 'boreal-conifer'
  | 'primeval-redwood'
  | 'tropical-wet'
  | 'palm-oasis'
  | 'savanna'
  | 'arid-woodland'

interface ForestSpeciesMix {
  species: TreeSpecies
  weight: number
  variations: readonly number[]
  scale: readonly [number, number]
}

/**
 * Stems that are lying down rather than standing up.
 *
 * A closed old-growth stand is defined as much by what has fallen in it as by
 * what is still upright: a mossy log across the floor is the element that
 * gives a forest photograph its foreground, its sense of time, and most of its
 * relief. They are generated as ordinary placements pitched onto their side,
 * so they instance with everything else and cost no extra prototype.
 */
export interface ForestDeadfall {
  /** Fraction of accepted stems that fall instead of standing. */
  rate: number
  species: TreeSpecies
  variations: readonly number[]
  scale: readonly [number, number]
}

export interface ForestPreset {
  id: ForestPresetId
  label: string
  description: string
  treesPerHectare: number
  gapRate: number
  clustering: number
  mix: readonly ForestSpeciesMix[]
  deadfall?: ForestDeadfall
}

export interface GeneratedForestTree {
  species: TreeSpecies
  variation: number
  position: readonly [number, number, number]
  rotation: number
  scale: number
  /**
   * Radians of pitch about the placement's own X axis. A standing stem is 0;
   * a fallen one is near a right angle, with the variance that decides whether
   * it is lying flat or propped against a neighbour.
   */
  tilt: number
}

/**
 * A deterministic boulder placement generated alongside a forest layout.
 *
 * Rocks stay as lightweight placement data here; the scene decides how to
 * materialize them. Keeping the seed on each placement gives a renderer a
 * stable granite/material variation without coupling this preset module to the
 * terrain rock implementation.
 */
export interface GeneratedForestRock {
  seed: number
  position: readonly [number, number, number]
  rotation: number
  scale: number
}

export const FOREST_PRESETS: readonly ForestPreset[] = [
  {
    id: 'mossy-old-growth',
    label: 'Mossy old-growth beech',
    description:
      'Closed southern-beech interior: crowded slim stems under a few veterans, suppressed saplings below.',
    // A closed stand, and the number that matters most in the whole file.
    //
    // At a hundred and twenty stems a hectare — a parkland density — an
    // eye-level camera sees the horizon between the trunks, the sun reaches
    // the floor everywhere, and no amount of grading makes that read as a
    // forest interior: it reads as an orchard, because it is one. Real
    // closed-canopy beech runs four to eight hundred stems a hectare, and it
    // is the crowding that closes the canopy, occludes the sky, and leaves the
    // floor lit only by the dapples that make the reference photograph.
    // Down from 560, and the reasoning that put it there was half right.
    //
    // Four to eight hundred stems a hectare is a real number for closed beech,
    // and it is a number for a *pole stage* stand: thin stems, twenty
    // centimetres through, competing for the light that will kill most of
    // them. This preset's stems are not that. Its mix is veterans at 1.15 to
    // 1.45 scale over crowded mature trunks, and a mature high forest of that
    // size carries a hundred and fifty to three hundred. Putting veteran boles
    // at pole-stage spacing gives a stand with no floor light at all and no
    // room to stand between the trunks — which is exactly how it read: a wall
    // of bark in every direction with the ground in permanent shadow.
    treesPerHectare: 380,
    // Real glades, not a scattering of bare patches.
    //
    // This was 0.04, on the argument that a closed stand has gaps only where a
    // veteran has fallen. True, and a stand that has been standing for three
    // hundred years has had a lot of veterans fall: the gaps are where all the
    // regeneration is, they are where the bracken and bramble actually grow,
    // and they are the only places a shaft of sun reaches the floor. A closed
    // canopy with no gaps is not dark and moody, it is evenly grey.
    gapRate: 0.14,
    clustering: 0.4,
    mix: [
      // The canopy: crowded, near-vertical, competing stems of one species at
      // a wide range of ages, which is what an even-aged closed stand is.
      // Weighted to the high-canopy recipe: a stem grown in a closed stand
      // self-prunes its low limbs and puts everything into height, which is
      // what gives the interior its clean boles and its ceiling.
      { species: 'european-beech', weight: 26, variations: [1], scale: [0.86, 1.2] },
      { species: 'european-beech', weight: 12, variations: [0], scale: [0.86, 1.1] },
      { species: 'european-beech', weight: 26, variations: [5], scale: [0.6, 0.92] },
      // The veterans the eye reads scale from: fewer, far heavier, buttressed.
      { species: 'european-beech', weight: 10, variations: [4], scale: [1.15, 1.45] },
      { species: 'field-oak', weight: 8, variations: [4], scale: [1.0, 1.3] },
      // Wind-shaped stems: a leaning axis over a level root plate, with the
      // crown pulled to one side. Every other recipe in this mix grows dead
      // plumb, and a stand of identical vertical stems is the clearest tell
      // that they came from one prototype.
      { species: 'european-beech', weight: 14, variations: [3], scale: [0.8, 1.15] },
      // What the veterans that already fell left behind. Sparse — a stump is a
      // landmark on a forest floor, and a field of them reads as a clear-fell.
      { species: 'european-beech', weight: 5, variations: [9], scale: [0.75, 1.2] },
      // Understory.
      //
      // This was a fifth of the stand as full-height tree ferns, and it was
      // the loudest wrong note in the frame: a southern-beech interior is a
      // dark, near-monochrome green, and a tree fern's fronds are the one
      // thing in the catalogue that renders as bright yellow-green. Twenty-two
      // of them at eye level turned every view into a fernery. What a closed
      // beech stand actually has between the floor and the canopy is mostly
      // nothing — that is what "closed" means — plus suppressed saplings of
      // its own species waiting for a gap, and a few ferns low enough to read
      // as ground cover rather than as a second canopy.
      // No tree ferns at all in the end. Even at a sixth of their original
      // weight and half their height they were the brightest thing in every
      // frame: a frond renders as a near-saturated lime green, and against an
      // interior graded to a mean luminance of about 0.2 a single one takes
      // the whole exposure with it. There are none in the reference.
      { species: 'european-beech', weight: 22, variations: [5], scale: [0.28, 0.46] },
      // A hazel layer, kept deliberately thin. Hazel under beech is the
      // classic pairing, but a closed canopy suppresses it — a stand carrying
      // as much shrub as the reference photographs show has gaps this preset
      // does not. Enough to break the bare-floor read at eye level and no
      // more. Elder is rarer still: it wants a gap and a richer soil than the
      // inside of a closed stand offers.
      { species: 'hazel-thicket', weight: 10, variations: [0], scale: [0.7, 1.05] },
      { species: 'elder-bush', weight: 4, variations: [0], scale: [0.7, 1.0] },
    ],
    // Storm relics: snapped stems, so the fallen end reads as a broken bole
    // rather than as a tree that was picked up and set down sideways.
    deadfall: {
      // Sparse: a log is a landmark in a frame, and a floor criss-crossed
      // with them reads as a windthrow rather than as old growth.
      rate: 0.055,
      species: 'european-beech',
      // Storm relics only. The veteran recipe keeps its whole limb structure,
      // and a complete crown lying on its side is a bramble of clean sticks —
      // the opposite of the bare mossy bole a fallen tree actually leaves.
      variations: [7],
      scale: [0.85, 1.3],
    },
  },
  {
    id: 'temperate-mixed',
    label: 'Temperate mixed woodland',
    description: 'Oak and beech canopy with birch succession and spruce pockets.',
    treesPerHectare: 125,
    gapRate: 0.12,
    clustering: 0.58,
    mix: [
      { species: 'field-oak', weight: 34, variations: [0, 2], scale: [0.78, 1.16] },
      { species: 'european-beech', weight: 28, variations: [0, 5], scale: [0.78, 1.12] },
      { species: 'silver-birch', weight: 24, variations: [0, 3], scale: [0.72, 1.08] },
      { species: 'norway-spruce', weight: 14, variations: [0, 1], scale: [0.8, 1.1] },
      // An open mixed wood is where a shrub layer actually belongs: enough
      // light reaches the floor to support one, and it is most of what makes
      // the difference between woodland and an orchard at eye level.
      { species: 'hazel-thicket', weight: 18, variations: [0], scale: [0.72, 1.12] },
      { species: 'elder-bush', weight: 10, variations: [0], scale: [0.72, 1.08] },
      { species: 'field-oak', weight: 12, variations: [3], scale: [0.76, 1.1] },
      { species: 'silver-birch', weight: 6, variations: [9], scale: [0.7, 1.1] },
    ],
  },
  {
    id: 'ancient-oak-grove',
    label: 'Ancient oak grove',
    description: 'A loose veteran parkland with open-grown crowns and young recruits.',
    treesPerHectare: 52,
    gapRate: 0.28,
    clustering: 0.28,
    mix: [
      { species: 'ancient-oak', weight: 72, variations: [0, 4], scale: [0.86, 1.18] },
      { species: 'field-oak', weight: 28, variations: [2, 5], scale: [0.68, 0.98] },
      // Wood pasture: widely spaced veterans over scrub. The shrubs are what
      // fill the ground between them, and without them the preset is a lawn
      // with trees on it.
      { species: 'hazel-thicket', weight: 22, variations: [0], scale: [0.78, 1.2] },
      { species: 'common-juniper', weight: 14, variations: [0], scale: [0.8, 1.35] },
      // Wood pasture is where stumps are most legible: nothing is hiding them.
      { species: 'ancient-oak', weight: 7, variations: [9], scale: [0.9, 1.35] },
    ],
  },
  {
    id: 'boreal-conifer',
    label: 'Boreal conifer forest',
    description: 'Dense spruce structure, pine openings, and colonizing birch clusters.',
    treesPerHectare: 178,
    gapRate: 0.08,
    clustering: 0.66,
    mix: [
      { species: 'norway-spruce', weight: 58, variations: [0, 3], scale: [0.7, 1.14] },
      { species: 'windswept-pine', weight: 28, variations: [0, 5], scale: [0.76, 1.12] },
      { species: 'silver-birch', weight: 14, variations: [3, 5], scale: [0.68, 0.96] },
      // Juniper is the boreal understory — it takes the cold and the acid soil
      // that keeps everything else out.
      { species: 'common-juniper', weight: 20, variations: [0], scale: [0.75, 1.3] },
      { species: 'norway-spruce', weight: 10, variations: [3], scale: [0.72, 1.08] },
      { species: 'norway-spruce', weight: 6, variations: [9], scale: [0.75, 1.15] },
    ],
  },
  {
    id: 'primeval-redwood',
    label: 'Primeval redwood forest',
    description: 'Monumental redwoods and sequoias above shaded tree-fern understory.',
    treesPerHectare: 72,
    gapRate: 0.16,
    clustering: 0.48,
    mix: [
      { species: 'coast-redwood', weight: 52, variations: [0, 5], scale: [0.76, 1.12] },
      { species: 'giant-sequoia', weight: 24, variations: [0, 4], scale: [0.82, 1.1] },
      { species: 'tree-fern', weight: 24, variations: [0, 5], scale: [0.7, 1.18] },
    ],
  },
  {
    id: 'tropical-wet',
    label: 'Tropical wet forest',
    description: 'Layered emergents, fused figs, broad banyans, and fern understory.',
    treesPerHectare: 112,
    gapRate: 0.1,
    clustering: 0.7,
    mix: [
      { species: 'kapok-ceiba', weight: 20, variations: [0, 5], scale: [0.72, 1.1] },
      { species: 'strangler-fig', weight: 26, variations: [0, 6], scale: [0.72, 1.12] },
      { species: 'banyan', weight: 24, variations: [0, 2], scale: [0.72, 1.08] },
      { species: 'tree-fern', weight: 30, variations: [0, 5], scale: [0.68, 1.2] },
    ],
  },
  {
    id: 'palm-oasis',
    label: 'Palm oasis',
    description: 'Date-palm core with coconut and branching doum silhouettes at the edge.',
    treesPerHectare: 62,
    gapRate: 0.22,
    clustering: 0.76,
    mix: [
      { species: 'date-palm', weight: 54, variations: [0, 3], scale: [0.76, 1.12] },
      { species: 'coconut-palm', weight: 28, variations: [0, 5], scale: [0.78, 1.14] },
      { species: 'doum-palm', weight: 18, variations: [0, 6], scale: [0.78, 1.08] },
    ],
  },
  {
    id: 'savanna',
    label: 'Open savanna',
    description: 'Wide-spaced umbrella acacias punctuated by rare baobab landmarks.',
    treesPerHectare: 26,
    gapRate: 0.36,
    clustering: 0.24,
    mix: [
      { species: 'umbrella-acacia', weight: 82, variations: [0, 3], scale: [0.74, 1.16] },
      { species: 'baobab', weight: 18, variations: [0, 4], scale: [0.8, 1.16] },
    ],
  },
  {
    id: 'arid-woodland',
    label: 'Arid sculptural woodland',
    description: 'Joshua, quiver, and dragon-blood forms arranged in sparse rocky groups.',
    treesPerHectare: 44,
    gapRate: 0.3,
    clustering: 0.52,
    mix: [
      { species: 'joshua-tree', weight: 42, variations: [0, 6], scale: [0.7, 1.16] },
      { species: 'quiver-tree', weight: 34, variations: [0, 5], scale: [0.72, 1.14] },
      { species: 'dragon-blood', weight: 24, variations: [0, 2], scale: [0.78, 1.08] },
    ],
  },
] as const

/**
 * Hard ceiling on planted stems, whatever area and density ask for.
 *
 * The budget used to grow as the geometric mean of the requested area and a
 * thirty-metre reference stand, with a ceiling of four hundred and eighty. That
 * made `treesPerHectare` a number the layout did not actually honour: doubling
 * a field's radius quadrupled its area and only doubled its stems, so a large
 * forest was *thinner per hectare* than a small one and every field converged
 * on roughly the same few hundred trees however big it was drawn. The stated
 * reason was the right one at the time — it had to stay inside what the machine
 * could draw, and every stem was geometry.
 *
 * `TreeImpostorBand` is what retires that constraint. Past the handover
 * distance a stem is two triangles sampling a baked atlas, so a closed stand at
 * its real density is affordable and `treesPerHectare` can mean what it says.
 * The ceiling that remains is about the *bake*: the layout rejection-samples
 * and queries terrain height per accepted stem, and one field is grown per
 * frame, so this bounds how long a single field's regrow can take.
 */
const MAX_STEMS = 20_000

/**
 * The tree lab's own stand keeps the old budget, and should.
 *
 * The lab draws every stem as geometry — it is where the trees themselves are
 * judged, so cards would defeat the point — and it is therefore still bound by
 * the hardware ceiling the terrain fields have escaped. Growing as the
 * geometric mean of the requested area and a thirty-metre reference stand is
 * what keeps a wide lab stand inside that, at the cost of not honouring
 * `treesPerHectare` literally. On terrain, where the far stems are cards, the
 * literal reading is both affordable and correct.
 */
const REFERENCE_HECTARES = Math.PI * 30 * 30 / 10_000
const MAX_LAB_STEMS = 480

export function generateForestLayout(
  presetId: ForestPresetId,
  seed: number,
  radius: number,
  density: number,
): GeneratedForestTree[] {
  const preset = FOREST_PRESETS.find((candidate) => candidate.id === presetId)
    ?? FOREST_PRESETS[0]
  const random = mulberry32(seed ^ hashString(preset.id))

  const hectares = Math.PI * radius * radius / 10_000
  const budget = Math.max(
    8,
    Math.min(
      MAX_LAB_STEMS,
      Math.round(
        preset.treesPerHectare
          * Math.sqrt(hectares * REFERENCE_HECTARES)
          * density,
      ),
    ),
  )

  // Density varies across the stand, but every part of it is stand. Spending
  // the budget on a fraction of the ground at full density instead — groves
  // with open country between — is a real landscape, and it is not a forest:
  // it reads as islands of trees rather than as woods you are inside of.
  // The noise modulates how thick the wood is, never whether it is there.
  const thinnest = 0.42

  const accepted: Array<GeneratedForestTree & { spacing: number }> = []
  const grid = new SpacingGrid(24)

  // The spacing grid is what makes a high attempt count affordable — the
  // previous linear scan over every accepted tree was quadratic and set the
  // practical ceiling on both count and spread.
  const maxAttempts = Math.min(600_000, budget * 120)
  // Once the stand is packed, further candidates fail on spacing forever. The
  // streak is what ends the search then, rather than grinding out the whole
  // attempt budget for nothing.
  const saturatedAfter = 6_000
  let sinceAccepted = 0

  for (let attempt = 0; attempt < maxAttempts && accepted.length < budget; attempt += 1) {
    if (sinceAccepted > saturatedAfter) break
    sinceAccepted += 1
    const angle = random() * Math.PI * 2
    // Square-rooted so candidates are uniform over the disc rather than piled
    // at the middle — the reason the old layout read as one blob in the centre
    // of a four-hundred-metre ground.
    const distance = Math.sqrt(random()) * radius
    const x = Math.cos(angle) * distance
    const z = Math.sin(angle) * distance

    // Thicker here, thinner there, and the odd genuine clearing where the
    // field bottoms out — but woodland throughout.
    const field = standCover(x, z, seed) - preset.gapRate
    const inStand = thinnest + (1 - thinnest) * Math.min(1, Math.max(0, field))
    // Stands do not end at a surveyed line. The outer fifth thins to scattered
    // stems, which is what a wood looks like from outside it.
    const fringe = 1 - smoothstep(radius * 0.8, radius, distance)
    if (random() > inStand * fringe) continue

    const mixIndex = weightedIndex(preset.mix, random())
    const entry = preset.mix[mixIndex]!
    const deadfall = preset.deadfall && random() < preset.deadfall.rate
      ? preset.deadfall
      : undefined
    const source = deadfall ?? entry
    const variation = source.variations[Math.floor(random() * source.variations.length)]!
    // Open-grown trees are the big spreading ones; a stem inside a closed grove
    // spent its life reaching for light between neighbours and stayed slim.
    // Biasing where in the authored range this one lands, rather than scaling
    // the result, keeps every tree inside the size the preset asked for.
    const openness = 1 - Math.min(1, Math.max(0, field))
    const roll = lerp(random(), openness, 0.35)
    const scale = source.scale[0] + roll * (source.scale[1] - source.scale[0])
    const species = deadfall?.species ?? entry.species
    const speciesPreset = TREE_SPECIES_PRESETS[species]
    const crown = speciesPreset.crownRadius
    // A log occupies a line, not a disc, so it is allowed to lie much closer
    // to its neighbours than a standing stem of the same species.
    const spacing = deadfall
      ? Math.max(0.8, speciesPreset.trunkRadius * 1.6) * scale
      : Math.max(1.35, Math.min(5.2, crown * 0.2)) * scale
    if (grid.overlaps(x, z, spacing)) continue

    grid.insert(x, z, spacing)
    sinceAccepted = 0
    accepted.push({
      species,
      variation,
      // Pitched onto its side and lifted by its own radius so the bole rests
      // on the litter instead of being buried to its axis.
      position: [x, deadfall ? speciesPreset.trunkRadius * scale * 0.82 : 0, z],
      rotation: random() * Math.PI * 2,
      scale,
      tilt: deadfall ? Math.PI * 0.5 + (random() - 0.5) * 0.22 : 0,
      spacing,
    })
  }
  return accepted.map(({ spacing: _spacing, ...tree }) => tree)
}

/**
 * The same layout, over an arbitrary painted region rather than a disc.
 *
 * A forest drawn on terrain is a shape somebody dragged, not a circle centred
 * on the origin, and the two differ in exactly one place: where a candidate
 * comes from and whether it is inside. Everything downstream — the budget, the
 * mix, the deadfall, the open-grown size bias, the spacing test — is the disc
 * generator's, unchanged, because none of it ever depended on the shape.
 *
 * The fringe term is gone because the region carries its own: `feather` on the
 * field already thins the stand across the boundary, and applying a second
 * radial taper on top of it would thin a wood twice at an edge that is not
 * radial in the first place.
 */
export function generateForestLayoutInRegion(
  presetId: ForestPresetId,
  seed: number,
  region: LayoutRegion,
  density: number,
): GeneratedForestTree[] {
  const preset = FOREST_PRESETS.find((candidate) => candidate.id === presetId)
    ?? FOREST_PRESETS[0]
  const random = mulberry32(seed ^ hashString(preset.id))

  // Linear in area, which is what "stems per hectare" means. See `MAX_STEMS`.
  const hectares = Math.max(1e-4, region.area / 10_000)
  const budget = Math.max(
    4,
    Math.min(MAX_STEMS, Math.round(preset.treesPerHectare * hectares * density)),
  )

  const thinnest = 0.42
  const accepted: Array<GeneratedForestTree & { spacing: number }> = []
  const grid = new SpacingGrid(24)
  const spanX = region.bounds.maxX - region.bounds.minX
  const spanZ = region.bounds.maxZ - region.bounds.minZ

  // Both scale with the budget now that the budget can be large. Fixed limits
  // sized for a few hundred stems stop a ten-thousand-stem field less than
  // halfway in, which looks exactly like the density cap it replaced.
  const maxAttempts = Math.min(4_000_000, Math.max(60_000, budget * 120))
  const saturatedAfter = Math.max(6_000, budget * 3)
  let sinceAccepted = 0

  for (let attempt = 0; attempt < maxAttempts && accepted.length < budget; attempt += 1) {
    if (sinceAccepted > saturatedAfter) break
    sinceAccepted += 1
    const x = region.bounds.minX + random() * spanX
    const z = region.bounds.minZ + random() * spanZ

    // The drawn shape decides whether there is forest here at all; the habitat
    // noise decides how thick it is where there is.
    const inRegion = region.coverage(x, z)
    if (inRegion <= 0.002) continue
    const field = standCover(x, z, seed) - preset.gapRate
    const inStand = thinnest + (1 - thinnest) * Math.min(1, Math.max(0, field))
    if (random() > inStand * inRegion) continue

    const mixIndex = weightedIndex(preset.mix, random())
    const entry = preset.mix[mixIndex]!
    const deadfall = preset.deadfall && random() < preset.deadfall.rate
      ? preset.deadfall
      : undefined
    const source = deadfall ?? entry
    const variation = source.variations[Math.floor(random() * source.variations.length)]!
    const openness = 1 - Math.min(1, Math.max(0, field))
    const roll = lerp(random(), openness, 0.35)
    const scale = source.scale[0] + roll * (source.scale[1] - source.scale[0])
    const species = deadfall?.species ?? entry.species
    const speciesPreset = TREE_SPECIES_PRESETS[species]
    const crown = speciesPreset.crownRadius
    const spacing = deadfall
      ? Math.max(0.8, speciesPreset.trunkRadius * 1.6) * scale
      : Math.max(1.35, Math.min(5.2, crown * 0.2)) * scale
    if (grid.overlaps(x, z, spacing)) continue

    grid.insert(x, z, spacing)
    sinceAccepted = 0
    accepted.push({
      species,
      variation,
      position: [x, deadfall ? speciesPreset.trunkRadius * scale * 0.82 : 0, z],
      rotation: random() * Math.PI * 2,
      scale,
      tilt: deadfall ? Math.PI * 0.5 + (random() - 0.5) * 0.22 : 0,
      spacing,
    })
  }
  return accepted.map(({ spacing: _spacing, ...tree }) => tree)
}

/** Boulders over the same region, on the same terms. */
export function generateForestRockLayoutInRegion(
  presetId: ForestPresetId,
  seed: number,
  region: LayoutRegion,
  density: number,
): GeneratedForestRock[] {
  const preset = FOREST_PRESETS.find((candidate) => candidate.id === presetId)
    ?? FOREST_PRESETS[0]
  const hectares = Math.max(0, region.area / 10_000)
  const openness = 0.75 + preset.gapRate * 1.5
  const targetCount = Math.min(
    48,
    Math.max(0, Math.round(hectares * 42 * density * openness)),
  )
  if (targetCount === 0) return []

  const random = mulberry32(seed ^ hashString(`${preset.id}:rocks`))
  const accepted: Array<GeneratedForestRock & { spacing: number }> = []
  const spanX = region.bounds.maxX - region.bounds.minX
  const spanZ = region.bounds.maxZ - region.bounds.minZ

  for (
    let attempt = 0;
    attempt < targetCount * 60 && accepted.length < targetCount;
    attempt += 1
  ) {
    const x = region.bounds.minX + random() * spanX
    const z = region.bounds.minZ + random() * spanZ
    if (random() > region.coverage(x, z)) continue
    const scale = 0.65 + random() * 1.35
    const spacing = 1.8 * scale
    const overlaps = accepted.some((rock) => {
      const dx = rock.position[0] - x
      const dz = rock.position[2] - z
      const minimum = (rock.spacing + spacing) * 0.72
      return dx * dx + dz * dz < minimum * minimum
    })
    if (overlaps) continue
    accepted.push({
      seed: Math.floor(random() * 0x7fffffff) + 1,
      position: [x, 0, z],
      rotation: random() * Math.PI * 2,
      scale,
      spacing,
    })
  }
  return accepted.map(({ spacing: _spacing, ...rock }) => rock)
}

/**
 * What a layout needs to know about a drawn shape.
 *
 * Deliberately structural rather than an import of `ForestRegion`: the preset
 * table has no business depending on the editor's spline representation, and
 * anything that can answer "how much forest is at this point" can drive it.
 */
export interface LayoutRegion {
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number }
  /** Square metres of forest, coverage-weighted. Sets the stem budget. */
  area: number
  coverage(x: number, z: number): number
}

/**
 * Uniform-grid neighbour lookup for the spacing test.
 *
 * Every candidate used to be compared against every tree already placed, which
 * is fine for a hundred and unworkable for the tens of thousands of candidates
 * a sparse, wide stand has to reject. Only trees within a couple of cells can
 * possibly be too close, and the cell is sized to the largest spacing any
 * species asks for.
 */
class SpacingGrid {
  private readonly cell: number
  private readonly buckets = new Map<number, Array<[number, number, number]>>()

  constructor(cell: number) {
    this.cell = cell
  }

  private key(gx: number, gz: number): number {
    return (Math.imul(gx, 0x45d9f3b) ^ Math.imul(gz, 0x27d4eb2d)) | 0
  }

  overlaps(x: number, z: number, spacing: number): boolean {
    const gx = Math.floor(x / this.cell)
    const gz = Math.floor(z / this.cell)
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const bucket = this.buckets.get(this.key(gx + dx, gz + dz))
        if (!bucket) continue
        for (const [px, pz, pSpacing] of bucket) {
          const ex = px - x
          const ez = pz - z
          const minimum = (pSpacing + spacing) * 0.7
          if (ex * ex + ez * ez < minimum * minimum) return true
        }
      }
    }
    return false
  }

  insert(x: number, z: number, spacing: number): void {
    const key = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))
    const bucket = this.buckets.get(key)
    if (bucket) bucket.push([x, z, spacing])
    else this.buckets.set(key, [[x, z, spacing]])
  }
}

/**
 * Where the stand is, as a field in 0..1.
 *
 * Three scales, because a wood is structured at three: a broad one that decides
 * which part of the ground carries forest at all, a grove-sized one that breaks
 * that into stands and glades, and a fine one for the gaps around individual
 * veterans. One octave — which is what this was — gives evenly spaced blobs of
 * one size, and reads as a pattern rather than as terrain.
 */
function standCover(x: number, z: number, seed: number): number {
  const broad = habitatNoise(x / 4.1, z / 4.1, seed)
  const grove = habitatNoise(x / 1.55, z / 1.55, seed ^ 0x9e3779b9)
  const gaps = habitatNoise(x / 0.62, z / 0.62, seed ^ 0x85ebca6b)
  const sum = broad * 0.55 + grove * 0.31 + gaps * 0.14
  // Summing octaves piles the result around one half — the standard deviation
  // of this particular weighting is 0.187, not the 0.289 a uniform field would
  // have. Thresholding that directly rejects roughly twice the ground it was
  // asked to, which is why a wider stand came back thinner than a narrow one.
  // Pushing the sum through the matching normal CDF flattens it back out, so
  // "cover" means the fraction it says.
  return 1 / (1 + Math.exp(-1.702 * ((sum - 0.5) / 0.187)))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Generate sparse, deterministic boulders for the forest floor.
 *
 * The count follows area rather than tree count so changing a species mix does
 * not unexpectedly cover the floor with stones. A small amount of extra
 * weight for open presets keeps savanna and arid layouts from looking empty,
 * while the cap prevents a large editor radius from creating an unreasonable
 * number of rock assets.
 */
export function generateForestRockLayout(
  presetId: ForestPresetId,
  seed: number,
  radius: number,
  density: number,
): GeneratedForestRock[] {
  const preset = FOREST_PRESETS.find((candidate) => candidate.id === presetId)
    ?? FOREST_PRESETS[0]
  const hectares = Math.PI * radius * radius / 10_000
  const openness = 0.75 + preset.gapRate * 1.5
  const targetCount = Math.min(
    48,
    Math.max(0, Math.round(hectares * 42 * density * openness)),
  )
  if (targetCount === 0) return []

  const random = mulberry32(seed ^ hashString(`${preset.id}:rocks`))
  const accepted: Array<GeneratedForestRock & { spacing: number }> = []

  for (let attempt = 0; attempt < targetCount * 40 && accepted.length < targetCount; attempt += 1) {
    const angle = random() * Math.PI * 2
    const distance = Math.sqrt(random()) * radius * 0.94
    const x = Math.cos(angle) * distance
    const z = Math.sin(angle) * distance
    const scale = 0.65 + random() * 1.35
    const spacing = 1.8 * scale
    const overlaps = accepted.some((rock) => {
      const dx = rock.position[0] - x
      const dz = rock.position[2] - z
      const minimum = (rock.spacing + spacing) * 0.72
      return dx * dx + dz * dz < minimum * minimum
    })
    if (overlaps) continue

    accepted.push({
      seed: Math.floor(random() * 0x7fffffff) + 1,
      position: [x, 0, z],
      rotation: random() * Math.PI * 2,
      scale,
      spacing,
    })
  }

  return accepted.map(({ spacing: _spacing, ...rock }) => rock)
}

function weightedIndex(mix: readonly ForestSpeciesMix[], roll: number): number {
  const total = mix.reduce((sum, entry) => sum + entry.weight, 0)
  let cursor = roll * total
  for (let index = 0; index < mix.length; index += 1) {
    cursor -= mix[index]!.weight
    if (cursor <= 0) return index
  }
  return mix.length - 1
}

function habitatNoise(x: number, z: number, seed: number): number {
  const cellSize = 22
  const gx = Math.floor(x / cellSize)
  const gz = Math.floor(z / cellSize)
  const tx = smooth(x / cellSize - gx)
  const tz = smooth(z / cellSize - gz)
  const a = gridHash(gx, gz, seed)
  const b = gridHash(gx + 1, gz, seed)
  const c = gridHash(gx, gz + 1, seed)
  const d = gridHash(gx + 1, gz + 1, seed)
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz)
}

function gridHash(x: number, z: number, seed: number): number {
  let value = seed ^ Math.imul(x, 0x1f123bb5) ^ Math.imul(z, 0x5f356495)
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d)
  value = Math.imul(value ^ (value >>> 12), 0x297a2d39)
  return ((value ^ (value >>> 15)) >>> 0) / 0xffffffff
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value)
}

function lerp(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}

function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000
  }
}
