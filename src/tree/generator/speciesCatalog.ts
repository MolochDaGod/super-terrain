export const TREE_GROWTH_MODELS = [
  'colonized-crown',
  'explicit-scaffold',
  'baobab-crown',
  'recursive-dichotomy',
  'monopodial-whorls',
  'apical-frond',
] as const

export type TreeGrowthModel = (typeof TREE_GROWTH_MODELS)[number]

export const TREE_ROOT_MODELS = [
  'basal-surface',
  'fibrous-mat',
  'buttress',
  'stilt',
  'prop',
  'aerial-support',
  'wrapping-fused',
] as const

export type TreeRootModel = (typeof TREE_ROOT_MODELS)[number]

export const TREE_ORGAN_MODELS = [
  'broadleaf-spray',
  'needle-spray',
  'frond',
  'terminal-rosette',
  'scale-foliage',
] as const

export type TreeOrganModel = (typeof TREE_ORGAN_MODELS)[number]

export const TREE_TRUNK_PROFILES = [
  'tapered',
  'columnar-flared',
  'bottle',
  'palm-column',
  'dichotomous-succulent',
  'conifer-excurrent',
  'giant-conifer',
] as const

export type TreeTrunkProfile = (typeof TREE_TRUNK_PROFILES)[number]

export interface TreeSpeciesDefinition<Id extends string = string> {
  id: Id
  label: string
  group: 'temperate-broadleaf' | 'conifer' | 'tropical' | 'palm' | 'succulent' | 'shrub'
  growthModel: TreeGrowthModel
  rootModel: TreeRootModel
  organModel: TreeOrganModel
  trunkProfile: TreeTrunkProfile
  barkProfile: string
  foliageProfile: string
}

/**
 * The species catalog is metadata, not generator dispatch. A species is added
 * here only when its structural builder and preset are usable; this prevents
 * half-implemented entries from appearing in the authoring UI.
 */
export const TREE_SPECIES_DEFINITIONS = [
  {
    id: 'ancient-oak',
    label: 'Ancient oak',
    group: 'temperate-broadleaf',
    growthModel: 'colonized-crown',
    rootModel: 'basal-surface',
    organModel: 'broadleaf-spray',
    trunkProfile: 'tapered',
    barkProfile: 'temperate-fissured',
    foliageProfile: 'oak-lobed',
  },
  {
    id: 'field-oak',
    label: 'Field oak',
    group: 'temperate-broadleaf',
    growthModel: 'colonized-crown',
    rootModel: 'basal-surface',
    organModel: 'broadleaf-spray',
    trunkProfile: 'tapered',
    barkProfile: 'temperate-fissured',
    foliageProfile: 'oak-lobed',
  },
  {
    id: 'windswept-pine',
    label: 'Windswept pine',
    group: 'conifer',
    growthModel: 'colonized-crown',
    rootModel: 'basal-surface',
    organModel: 'needle-spray',
    trunkProfile: 'conifer-excurrent',
    barkProfile: 'conifer-plated',
    foliageProfile: 'pine-needle',
  },
  {
    id: 'kapok-ceiba',
    label: 'Kapok / Ceiba',
    group: 'tropical',
    growthModel: 'explicit-scaffold',
    rootModel: 'buttress',
    organModel: 'broadleaf-spray',
    trunkProfile: 'columnar-flared',
    barkProfile: 'tropical-buttressed',
    foliageProfile: 'ceiba-palmate',
  },
  {
    id: 'baobab',
    label: 'Baobab',
    group: 'succulent',
    growthModel: 'baobab-crown',
    rootModel: 'basal-surface',
    organModel: 'broadleaf-spray',
    trunkProfile: 'bottle',
    barkProfile: 'baobab-smooth',
    foliageProfile: 'baobab-palmate',
  },
  {
    id: 'coconut-palm',
    label: 'Coconut palm',
    group: 'palm',
    growthModel: 'apical-frond',
    rootModel: 'fibrous-mat',
    organModel: 'frond',
    trunkProfile: 'palm-column',
    barkProfile: 'coconut-ringed',
    foliageProfile: 'coconut-frond',
  },
  {
    id: 'dragon-blood',
    label: 'Dragon blood tree',
    group: 'succulent',
    growthModel: 'recursive-dichotomy',
    rootModel: 'fibrous-mat',
    organModel: 'terminal-rosette',
    trunkProfile: 'dichotomous-succulent',
    barkProfile: 'dragon-scaled',
    foliageProfile: 'dragon-blood-rosette',
  },
  {
    id: 'norway-spruce',
    label: 'Norway spruce',
    group: 'conifer',
    growthModel: 'monopodial-whorls',
    rootModel: 'basal-surface',
    organModel: 'needle-spray',
    trunkProfile: 'conifer-excurrent',
    barkProfile: 'conifer-scaled',
    foliageProfile: 'spruce-needle',
  },
  {
    id: 'coast-redwood',
    label: 'Coast redwood',
    group: 'conifer',
    growthModel: 'monopodial-whorls',
    rootModel: 'basal-surface',
    organModel: 'scale-foliage',
    trunkProfile: 'conifer-excurrent',
    barkProfile: 'fibrous-redwood',
    foliageProfile: 'redwood-spray',
  },
  {
    id: 'monkey-puzzle',
    label: 'Monkey puzzle',
    group: 'conifer',
    growthModel: 'monopodial-whorls',
    rootModel: 'basal-surface',
    organModel: 'scale-foliage',
    trunkProfile: 'conifer-excurrent',
    barkProfile: 'araucaria-wrinkled',
    foliageProfile: 'araucaria-scale',
  },
  {
    id: 'date-palm',
    label: 'Date palm',
    group: 'palm',
    growthModel: 'apical-frond',
    rootModel: 'fibrous-mat',
    organModel: 'frond',
    trunkProfile: 'palm-column',
    barkProfile: 'date-palm-boots',
    foliageProfile: 'date-frond',
  },
  {
    id: 'tree-fern',
    label: 'Tree fern',
    group: 'tropical',
    growthModel: 'apical-frond',
    rootModel: 'fibrous-mat',
    organModel: 'frond',
    trunkProfile: 'palm-column',
    barkProfile: 'fern-fibrous',
    foliageProfile: 'tree-fern-frond',
  },
  {
    id: 'quiver-tree',
    label: 'Quiver tree',
    group: 'succulent',
    growthModel: 'recursive-dichotomy',
    rootModel: 'fibrous-mat',
    organModel: 'terminal-rosette',
    trunkProfile: 'dichotomous-succulent',
    barkProfile: 'smooth-golden',
    foliageProfile: 'quiver-rosette',
  },
  {
    id: 'doum-palm',
    label: 'Doum palm',
    group: 'palm',
    growthModel: 'recursive-dichotomy',
    rootModel: 'fibrous-mat',
    organModel: 'frond',
    trunkProfile: 'palm-column',
    barkProfile: 'doum-palm-boots',
    foliageProfile: 'doum-frond',
  },
  {
    id: 'joshua-tree',
    label: 'Joshua tree',
    group: 'succulent',
    growthModel: 'recursive-dichotomy',
    rootModel: 'fibrous-mat',
    organModel: 'terminal-rosette',
    trunkProfile: 'dichotomous-succulent',
    barkProfile: 'shaggy-yucca',
    foliageProfile: 'joshua-rosette',
  },
  {
    id: 'bristlecone-pine',
    label: 'Bristlecone pine',
    group: 'conifer',
    growthModel: 'colonized-crown',
    rootModel: 'basal-surface',
    organModel: 'needle-spray',
    trunkProfile: 'tapered',
    barkProfile: 'weathered-deadwood',
    foliageProfile: 'bristlecone-needle',
  },
  {
    id: 'screw-pine-pandanus',
    label: 'Screw pine / Pandanus',
    group: 'tropical',
    growthModel: 'apical-frond',
    rootModel: 'stilt',
    organModel: 'frond',
    trunkProfile: 'palm-column',
    barkProfile: 'pandanus-ringed',
    foliageProfile: 'pandanus-spiral',
  },
  {
    id: 'banyan',
    label: 'Banyan',
    group: 'tropical',
    growthModel: 'colonized-crown',
    rootModel: 'aerial-support',
    organModel: 'broadleaf-spray',
    trunkProfile: 'tapered',
    barkProfile: 'fig-smooth',
    foliageProfile: 'banyan-leaf',
  },
  {
    id: 'mangrove',
    label: 'Mangrove',
    group: 'tropical',
    growthModel: 'colonized-crown',
    rootModel: 'prop',
    organModel: 'broadleaf-spray',
    trunkProfile: 'tapered',
    barkProfile: 'mangrove-scaled',
    foliageProfile: 'mangrove-leaf',
  },
  {
    id: 'strangler-fig',
    label: 'Strangler fig',
    group: 'tropical',
    growthModel: 'colonized-crown',
    rootModel: 'wrapping-fused',
    organModel: 'broadleaf-spray',
    trunkProfile: 'tapered',
    barkProfile: 'fig-smooth',
    foliageProfile: 'fig-leaf',
  },
  {
    id: 'umbrella-acacia',
    label: 'Umbrella thorn acacia',
    group: 'tropical',
    growthModel: 'explicit-scaffold',
    rootModel: 'basal-surface',
    organModel: 'broadleaf-spray',
    trunkProfile: 'tapered',
    barkProfile: 'savanna-fissured',
    foliageProfile: 'acacia-compound',
  },
  {
    id: 'rainbow-eucalyptus',
    label: 'Rainbow eucalyptus',
    group: 'tropical',
    growthModel: 'colonized-crown',
    rootModel: 'buttress',
    organModel: 'broadleaf-spray',
    trunkProfile: 'columnar-flared',
    barkProfile: 'rainbow-peeling',
    foliageProfile: 'eucalyptus-pendulous',
  },
  {
    id: 'gum-eucalyptus',
    label: 'Gum tree / Eucalyptus',
    group: 'temperate-broadleaf',
    growthModel: 'colonized-crown',
    rootModel: 'basal-surface',
    organModel: 'broadleaf-spray',
    trunkProfile: 'tapered',
    barkProfile: 'gum-mottled',
    foliageProfile: 'eucalyptus-pendulous',
  },
  {
    id: 'giant-sequoia',
    label: 'Giant sequoia',
    group: 'conifer',
    growthModel: 'monopodial-whorls',
    rootModel: 'buttress',
    organModel: 'scale-foliage',
    trunkProfile: 'giant-conifer',
    barkProfile: 'fibrous-sequoia',
    foliageProfile: 'sequoia-spray',
  },
  {
    id: 'norfolk-island-pine',
    label: 'Norfolk Island pine',
    group: 'conifer',
    growthModel: 'monopodial-whorls',
    rootModel: 'basal-surface',
    organModel: 'scale-foliage',
    trunkProfile: 'conifer-excurrent',
    barkProfile: 'norfolk-peeling',
    foliageProfile: 'araucaria-scale',
  },
  {
    id: 'live-oak', label: 'Live oak', group: 'temperate-broadleaf',
    growthModel: 'explicit-scaffold', rootModel: 'basal-surface',
    organModel: 'broadleaf-spray', trunkProfile: 'tapered',
    barkProfile: 'live-oak-fissured', foliageProfile: 'live-oak-leaf',
  },
  {
    id: 'european-beech', label: 'European beech', group: 'temperate-broadleaf',
    growthModel: 'colonized-crown', rootModel: 'basal-surface',
    organModel: 'broadleaf-spray', trunkProfile: 'tapered',
    barkProfile: 'beech-smooth', foliageProfile: 'beech-leaf',
  },
  {
    id: 'silver-birch', label: 'Silver birch', group: 'temperate-broadleaf',
    growthModel: 'colonized-crown', rootModel: 'basal-surface',
    organModel: 'broadleaf-spray', trunkProfile: 'tapered',
    barkProfile: 'birch-white', foliageProfile: 'birch-leaf',
  },
  {
    id: 'cedar-of-lebanon', label: 'Cedar of Lebanon', group: 'conifer',
    growthModel: 'colonized-crown', rootModel: 'basal-surface',
    organModel: 'needle-spray', trunkProfile: 'conifer-excurrent',
    barkProfile: 'conifer-fissured', foliageProfile: 'cedar-needle',
  },
  {
    id: 'japanese-black-pine', label: 'Japanese black pine', group: 'conifer',
    growthModel: 'colonized-crown', rootModel: 'basal-surface',
    organModel: 'needle-spray', trunkProfile: 'conifer-excurrent',
    barkProfile: 'pine-plated-dark', foliageProfile: 'black-pine-needle',
  },
  // Shrubs. They take the colonized crown like the broadleaves do — mass fills
  // a volume from attractors rather than from a scaffold — and it is
  // `bolePlan: 'multistem'` in the preset plus `shrub()` in the architecture
  // that make the result a bush rather than a small tree.
  {
    id: 'hazel-thicket', label: 'Hazel thicket', group: 'shrub',
    growthModel: 'colonized-crown', rootModel: 'basal-surface',
    organModel: 'broadleaf-spray', trunkProfile: 'tapered',
    barkProfile: 'smooth-mottled', foliageProfile: 'hazel-leaf',
  },
  {
    id: 'elder-bush', label: 'Elder bush', group: 'shrub',
    growthModel: 'colonized-crown', rootModel: 'basal-surface',
    organModel: 'broadleaf-spray', trunkProfile: 'tapered',
    barkProfile: 'smooth-grey', foliageProfile: 'elder-pinnate',
  },
  {
    id: 'common-juniper', label: 'Common juniper', group: 'shrub',
    growthModel: 'colonized-crown', rootModel: 'basal-surface',
    // Fibrous and shredding, which is what a juniper stem actually does and
    // the closest thing in the bark set.
    organModel: 'needle-spray', trunkProfile: 'tapered',
    barkProfile: 'fibrous-redwood', foliageProfile: 'juniper-needle',
  },
] as const satisfies readonly TreeSpeciesDefinition[]

export type TreeSpecies = (typeof TREE_SPECIES_DEFINITIONS)[number]['id']

const DEFINITION_BY_ID = new Map<TreeSpecies, TreeSpeciesDefinition<TreeSpecies>>(
  TREE_SPECIES_DEFINITIONS.map((definition) => [definition.id, definition]),
)

export function treeSpeciesDefinition(
  species: TreeSpecies,
): TreeSpeciesDefinition<TreeSpecies> {
  return DEFINITION_BY_ID.get(species) ?? TREE_SPECIES_DEFINITIONS[0]
}

export function isTreeSpecies(value: unknown): value is TreeSpecies {
  return typeof value === 'string' && DEFINITION_BY_ID.has(value as TreeSpecies)
}
