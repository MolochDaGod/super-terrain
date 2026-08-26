import {
  TREE_SPECIES_PRESETS,
  type TreeSpecies,
} from './generator/types'

export type ForestPresetId =
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

export interface ForestPreset {
  id: ForestPresetId
  label: string
  description: string
  treesPerHectare: number
  gapRate: number
  clustering: number
  mix: readonly ForestSpeciesMix[]
}

export interface GeneratedForestTree {
  species: TreeSpecies
  variation: number
  position: readonly [number, number, number]
  rotation: number
  scale: number
}

export const FOREST_PRESETS: readonly ForestPreset[] = [
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
  const targetCount = Math.min(
    480,
    Math.max(8, Math.round(preset.treesPerHectare * hectares * density)),
  )
  const clusters = preset.mix.map((_, mixIndex) =>
    Array.from({ length: 3 }, (__, clusterIndex) => {
      const clusterRandom = mulberry32(
        seed ^ Math.imul(mixIndex + 3, 0x45d9f3b) ^ Math.imul(clusterIndex + 7, 0x27d4eb2d),
      )
      const angle = clusterRandom() * Math.PI * 2
      const distance = Math.sqrt(clusterRandom()) * radius * 0.72
      return [Math.cos(angle) * distance, Math.sin(angle) * distance] as const
    }),
  )
  const accepted: Array<GeneratedForestTree & { spacing: number }> = []

  for (let attempt = 0; attempt < targetCount * 80 && accepted.length < targetCount; attempt += 1) {
    const mixIndex = weightedIndex(preset.mix, random())
    const entry = preset.mix[mixIndex]!
    let x: number
    let z: number
    if (random() < preset.clustering) {
      const center = clusters[mixIndex]![Math.floor(random() * 3)]!
      const angle = random() * Math.PI * 2
      const spread = Math.sqrt(random()) * radius * (0.13 + (1 - preset.clustering) * 0.18)
      x = center[0] + Math.cos(angle) * spread
      z = center[1] + Math.sin(angle) * spread
    } else {
      const angle = random() * Math.PI * 2
      const distance = Math.sqrt(random()) * radius
      x = Math.cos(angle) * distance
      z = Math.sin(angle) * distance
    }
    if (x * x + z * z > radius * radius) continue
    if (habitatNoise(x, z, seed) < preset.gapRate) continue

    const variation = entry.variations[Math.floor(random() * entry.variations.length)]!
    const scale = entry.scale[0] + random() * (entry.scale[1] - entry.scale[0])
    const crown = TREE_SPECIES_PRESETS[entry.species].crownRadius
    const spacing = Math.max(1.35, Math.min(5.2, crown * 0.2)) * scale
    const overlaps = accepted.some((tree) => {
      const dx = tree.position[0] - x
      const dz = tree.position[2] - z
      const minimum = (tree.spacing + spacing) * 0.7
      return dx * dx + dz * dz < minimum * minimum
    })
    if (overlaps) continue
    accepted.push({
      species: entry.species,
      variation,
      position: [x, 0, z],
      rotation: random() * Math.PI * 2,
      scale,
      spacing,
    })
  }
  return accepted.map(({ spacing: _spacing, ...tree }) => tree)
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
