import type { FusedStemLobe } from './fusedStems'
import {
  isTreeSpecies,
  type TreeOrganModel,
  type TreeSpecies,
} from './speciesCatalog'

export type { TreeSpecies } from './speciesCatalog'

export interface TreeVec3 {
  x: number
  y: number
  z: number
}

export type TreePartType = 'trunk' | 'branch' | 'root' | 'twig'
export type TreeJunctionType =
  | 'root-flare'
  | 'continuation'
  | 'lateral'
  | 'bifurcation'
  | 'terminal'

/** Independent structural traits; any plan, axis and damage state can compose. */
export type TreeBolePlan =
  | 'auto'
  | 'single'
  | 'codominant'
  | 'multistem'
  | 'fused'
export type TreeAxisForm = 'auto' | 'straight' | 'leaning' | 'sinuous'
export type TreeTrunkDamage = 'auto' | 'intact' | 'snapped'
export type TreeCrownForm =
  | 'auto'
  | 'full'
  | 'stagheaded'
  | 'lopsided'
  | 'reiterated'
export type TreeRootForm =
  | 'auto'
  | 'braided'
  | 'buttressed'
  | 'stilted'
  | 'sunken'

export interface TreeParameters {
  seed: number
  species: TreeSpecies
  /** Independent structural traits. `auto` defers that trait to the seed. */
  bolePlan: TreeBolePlan
  axisForm: TreeAxisForm
  trunkDamage: TreeTrunkDamage
  crownForm: TreeCrownForm
  rootForm: TreeRootForm
  /** How far the bole leans from vertical, in degrees. */
  lean: number
  /** Depth of the bole's own S-curve, in trunk radii. */
  sinuosity: number
  /** Grain turns, or whole-axis weave turns when the bole plan is fused. */
  twist: number
  /** Depth of the vertical flutes between buttress ribs. */
  fluting: number
  /** How far surface roots rise clear of the soil, in root radii. */
  rootRelief: number
  /** How many times a surface root breaks the soil along its run. */
  rootSurfacings: number
  /** Limbs this individual has lost, each leaving a scar and often a rebuild. */
  lostLimbs: number
  height: number
  crownRadius: number
  trunkRadius: number
  age: number
  gnarl: number
  branchCount: number
  rootCount: number
  rootSpread: number
  rootExposure: number
  foliageDensity: number
}

/**
 * Authoring range for crown density. Values above 1 are deliberately allowed:
 * hero foliage now uses smaller, more believable sprays, and the upper half of
 * the range trades more instances for the dense crown the old oversized cards
 * achieved through sheer coverage.
 */
export const MAX_FOLIAGE_DENSITY = 2

export interface TreeEnvironment {
  /** A compact plane used by worker jobs. Runtime terrain can provide this fit per tree. */
  groundHeight: number
  slopeX: number
  slopeZ: number
  obstacles: readonly TreeObstacle[]
}

export interface TreeObstacle {
  id: string
  center: TreeVec3
  radius: number
}

/**
 * A buttress rib running out from a member along one horizontal direction.
 *
 * Fins are what make a veteran's base star-shaped in plan rather than round:
 * a broad ridge running out along every major root, with a deep concave valley
 * between each pair. Expressing that as a lobe *count* cannot work — the ribs
 * are not evenly spaced, there are as many of them as there are roots, and each
 * has to point exactly where its own root went. Anything less and the roots can
 * only ever be pipes bolted onto a cylinder.
 */
export interface TreeButtressFin {
  /** Unit horizontal world direction the rib runs along. */
  direction: TreeVec3
  /** How far the rib pushes the surface out, as a fraction of the radius. */
  strength: number
  /** Angular half-width of the rib, in radians. */
  width: number
}

export interface TreeCrossSection {
  radiusX: number
  radiusZ: number
  rotation: number
  lobeCount: number
  lobeStrength: number
  /** Axial leaf-base row phase for true palm-boot mesh relief. */
  palmBootPhase?: number
  /** Coconut-style annular scars instead of phyllotactic V-shaped boot lips. */
  palmRinged?: boolean
  /** Radial height of persistent palm-boot lips, as a fraction of girth. */
  palmBootRelief?: number
  /** Number of phyllotactic leaf-base ranks around this palm stipe. */
  palmBootRanks?: number
  /** Fraction of upper leaf bases retained as projecting geometry. */
  palmBootRetention?: number
  /** Buttress ribs at this station. Shared by reference along a member. */
  fins?: readonly TreeButtressFin[]
  /**
   * Offset stems whose union forms this outline, in units of the radius.
   *
   * Present only on members that really are several fused columns — a baobab
   * bole, a banyan's coalesced root trunk. Everything else leaves it undefined
   * and keeps the cheap elliptical section.
   */
  fusedStems?: readonly FusedStemLobe[]
  /** Fold softness for `fusedStems`, in units of the radius. */
  fusedStemBlend?: number
}

export interface TreeSpineSample {
  position: TreeVec3
  radius: number
  crossSection: TreeCrossSection
  /** Positive values put the root centre below terrain. Non-roots use zero. */
  burialDepth: number
}

export interface SemanticTreePart {
  id: string
  type: TreePartType
  parentId?: string
  children: string[]
  continuationChildId?: string
  branchOrder: number
  age: number
  vigor: number
  dominance: number
  attachment: number
  junctionType: TreeJunctionType
  /**
   * True for a root that carries load through the air before it reaches the
   * ground: a banyan pillar, a mangrove stilt, a strangler braid.
   *
   * The space solver holds ordinary roots at the soil surface, which is right
   * for a radial root and fatal for these — it flattened the whole descending
   * span onto the terrain and left only the single segment from the carrier as
   * a long straight pole through the canopy.
   */
  aerial?: boolean
  /**
   * True when this member's first stations are authored *inside* its parent.
   *
   * The mesher builds a projected collar for an ordinary lateral, which is
   * correct for a branch on a trunk and wrong for a union as thick as the wood
   * that carries it: the collar becomes a circular shelf. A member marked here
   * is compiled as a plain sweep whose opening rings are buried, and the shared
   * junction blend fuses the two exterior surfaces. It is a structural property
   * of the union, so it is recorded here rather than inferred from an id.
   */
  embedded?: boolean
  spine: TreeSpineSample[]
}

export type TreeContactType = 'touching' | 'crossing' | 'resting' | 'graft'

export interface TreeContact {
  partA: string
  partB: string
  locationA: TreeVec3
  locationB: TreeVec3
  type: TreeContactType
  age: number
  pressure: number
  fusion: number
}

export interface FoliageCluster {
  id: string
  partId: string
  center: TreeVec3
  axis: TreeVec3
  radius: number
  depth: number
  /** 0 on the sunlit crown surface, 1 in the shaded interior. Darkens cards. */
  occlusion: number
  /** 0 for live foliage, 1 for a retained dry or dead organ. */
  senescence?: number
  /** 0 for a tightly folded spear leaf, 1 for a fully expanded organ. */
  development?: number
  /** Selects the geometry treatment; the atlas profile still comes from species. */
  organModel: TreeOrganModel
  seed: number
}

export interface FruitCluster {
  id: string
  model: 'date-bunch' | 'coconut-cluster'
  partId: string
  center: TreeVec3
  axis: TreeVec3
  radial: TreeVec3
  strandCount: number
  spread: number
  length: number
  fruitRadius: number
  count: number
  seed: number
}

export interface SemanticTreeGraph {
  seed: number
  parts: SemanticTreePart[]
  contacts: TreeContact[]
  foliageClusters: FoliageCluster[]
  fruitClusters: FruitCluster[]
  bounds: TreeBounds
}

export interface TreeBounds {
  min: TreeVec3
  max: TreeVec3
}

export type TreeLodLevel = 0 | 1 | 2

export interface TreeMeshData {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  bounds: TreeBounds
  /** Maximum world-space deviation targeted while building this LOD. */
  geometricError: number
}

export type FoliageRepresentation = 'cards' | 'clusters'
export type FoliageCardGeometry = 'spray' | 'frond' | 'fan-frond' | 'rosette'

export interface TreeFoliageData {
  representation: FoliageRepresentation
  /** Mesh topology used by card instances; fronds need a real longitudinal arch. */
  cardGeometry: FoliageCardGeometry
  matrices: Float32Array
  colors: Float32Array
  /** Atlas spray each card draws. Cards are batched one instanced mesh per variant. */
  variants: Uint8Array
  variantCount: number
  count: number
}

export interface TreeFruitData {
  matrices: Float32Array
  colors: Float32Array
  count: number
}

export interface TreeLodAsset {
  level: TreeLodLevel
  wood: TreeMeshData
  foliage: TreeFoliageData
  fruits: TreeFruitData
  includedPartCount: number
}

export interface TreeAssetStats {
  generationMs: number
  partCount: number
  contactCount: number
  foliageClusterCount: number
}

export interface ProceduralTreeAsset {
  parameters: TreeParameters
  environment: TreeEnvironment
  graph: SemanticTreeGraph
  lods: readonly [TreeLodAsset, TreeLodAsset, TreeLodAsset]
  stats: TreeAssetStats
}

export const DEFAULT_TREE_ENVIRONMENT: TreeEnvironment = {
  groundHeight: 0,
  slopeX: 0,
  slopeZ: 0,
  obstacles: [],
}

export const DEFAULT_TREE_PARAMETERS: TreeParameters = {
  seed: 84721,
  species: 'ancient-oak',
  // The showcase recipe is deliberately art-directed. `auto` remains
  // available for population generation, but a hero asset must not randomly
  // choose a retrenched crown or exposed-root regime that requires a different
  // composition and review camera.
  bolePlan: 'single',
  axisForm: 'sinuous',
  trunkDamage: 'intact',
  crownForm: 'full',
  rootForm: 'sunken',
  lean: 6,
  sinuosity: 0.55,
  twist: 0.5,
  fluting: 0.6,
  rootRelief: 1.2,
  rootSurfacings: 2,
  lostLimbs: 3,
  height: 22,
  crownRadius: 13.5,
  // A veteran oak's bole has to remain visually load-bearing beneath a
  // thirty-metre crown; the previous metre-wide radius read as an orchard
  // tree once the scaffold spread was corrected.
  trunkRadius: 1.34,
  age: 0.9,
  gnarl: 0.72,
  branchCount: 6,
  rootCount: 7,
  rootSpread: 9.5,
  rootExposure: 0.5,
  // The hero crown uses branchlet-scale sprays. A little over the neutral
  // density is required to close the major crown masses without inflating the
  // individual cards back into billboard clumps.
  foliageDensity: 1.45,
}

export const TREE_SPECIES_PRESETS: Record<TreeSpecies, TreeParameters> = {
  'ancient-oak': DEFAULT_TREE_PARAMETERS,
  'field-oak': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 31591,
    species: 'field-oak',
    bolePlan: 'auto',
    axisForm: 'auto',
    trunkDamage: 'auto',
    crownForm: 'auto',
    rootForm: 'auto',
    height: 21,
    crownRadius: 9,
    trunkRadius: 0.52,
    age: 0.58,
    gnarl: 0.36,
    branchCount: 5,
    rootCount: 6,
    rootSpread: 7,
    rootExposure: 0.42,
    foliageDensity: 0.9,
  },
  'windswept-pine': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 71023,
    species: 'windswept-pine',
    bolePlan: 'auto',
    axisForm: 'auto',
    trunkDamage: 'auto',
    crownForm: 'auto',
    rootForm: 'auto',
    height: 29,
    crownRadius: 6.2,
    trunkRadius: 0.46,
    age: 0.66,
    gnarl: 0.44,
    branchCount: 7,
    rootCount: 7,
    rootSpread: 6.8,
    rootExposure: 0.48,
    // Was 0.7, which is a *thinned* crown, and it was the only conifer in the
    // catalogue authored below one. A boreal stand's pines are not defoliated.
    foliageDensity: 1.05,
  },
  'kapok-ceiba': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 48127,
    species: 'kapok-ceiba',
    bolePlan: 'single',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'buttressed',
    twist: 0.18,
    fluting: 0.48,
    rootRelief: 0.78,
    rootSurfacings: 1,
    lostLimbs: 0,
    lean: 1,
    sinuosity: 0.08,
    height: 48,
    crownRadius: 13,
    trunkRadius: 1.65,
    age: 0.78,
    gnarl: 0.18,
    branchCount: 7,
    rootCount: 8,
    rootSpread: 12,
    rootExposure: 0.62,
    foliageDensity: 1.12,
  },
  baobab: {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 90217,
    species: 'baobab',
    bolePlan: 'single',
    axisForm: 'sinuous',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.12,
    fluting: 0.34,
    // The base is carried by the bole's own foot and shoulder ribs. Relief and
    // surfacings here only put flat straps of root back on the terrain.
    rootRelief: 0.3,
    rootSurfacings: 0,
    lostLimbs: 0,
    lean: 2,
    sinuosity: 0.22,
    height: 21,
    // A baobab's crown is broader than its bole is tall. The rejected render
    // had them nearly equal, which is why the tree read as a sandbag with a
    // shrub balanced on it however good the branch grammar underneath was.
    crownRadius: 12.5,
    trunkRadius: 2.95,
    age: 0.88,
    gnarl: 0.4,
    branchCount: 6,
    rootCount: 7,
    rootSpread: 11,
    rootExposure: 0.16,
    foliageDensity: 0.9,
  },
  'coconut-palm': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 66739,
    species: 'coconut-palm',
    bolePlan: 'single',
    axisForm: 'leaning',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.08,
    fluting: 0.06,
    rootRelief: 0.12,
    rootSurfacings: 0,
    lostLimbs: 0,
    lean: 11,
    sinuosity: 0.28,
    height: 24,
    crownRadius: 6.5,
    trunkRadius: 0.38,
    age: 0.7,
    gnarl: 0.08,
    branchCount: 15,
    rootCount: 7,
    rootSpread: 5.2,
    rootExposure: 0.12,
    foliageDensity: 1,
  },
  'dragon-blood': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 73331,
    species: 'dragon-blood',
    bolePlan: 'single',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.16,
    fluting: 0.18,
    rootRelief: 0.18,
    rootSurfacings: 0,
    lostLimbs: 0,
    lean: 2,
    sinuosity: 0.12,
    height: 11,
    crownRadius: 7.8,
    trunkRadius: 0.72,
    age: 0.82,
    gnarl: 0.2,
    branchCount: 6,
    rootCount: 6,
    rootSpread: 5.8,
    rootExposure: 0.16,
    foliageDensity: 1,
  },
  'norway-spruce': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 11837,
    species: 'norway-spruce',
    bolePlan: 'single',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.12,
    fluting: 0.12,
    rootRelief: 0.2,
    rootSurfacings: 1,
    lostLimbs: 0,
    lean: 1,
    sinuosity: 0.08,
    height: 34,
    crownRadius: 7.4,
    trunkRadius: 0.62,
    age: 0.68,
    gnarl: 0.08,
    branchCount: 10,
    rootCount: 7,
    rootSpread: 6.5,
    rootExposure: 0.2,
    foliageDensity: 1.06,
  },
  'coast-redwood': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 55271,
    species: 'coast-redwood',
    bolePlan: 'single',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'buttressed',
    twist: 0.18,
    fluting: 0.3,
    rootRelief: 0.42,
    rootSurfacings: 1,
    lostLimbs: 0,
    lean: 1,
    sinuosity: 0.06,
    height: 82,
    crownRadius: 10.5,
    trunkRadius: 2.3,
    age: 0.84,
    gnarl: 0.12,
    branchCount: 13,
    rootCount: 9,
    rootSpread: 11,
    rootExposure: 0.36,
    foliageDensity: 1.08,
  },
  'monkey-puzzle': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 34819,
    species: 'monkey-puzzle',
    bolePlan: 'single',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.1,
    fluting: 0.08,
    rootRelief: 0.15,
    rootSurfacings: 0,
    lostLimbs: 0,
    lean: 1,
    sinuosity: 0.05,
    height: 28,
    crownRadius: 6.8,
    trunkRadius: 0.62,
    age: 0.72,
    gnarl: 0.06,
    branchCount: 9,
    rootCount: 7,
    rootSpread: 6.2,
    rootExposure: 0.12,
    foliageDensity: 0.9,
  },
  'date-palm': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 62039,
    species: 'date-palm',
    bolePlan: 'single',
    axisForm: 'leaning',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.08,
    fluting: 0.08,
    rootRelief: 0.14,
    rootSurfacings: 0,
    lostLimbs: 0,
    lean: 5,
    sinuosity: 0.22,
    height: 18,
    crownRadius: 6.15,
    trunkRadius: 0.52,
    age: 0.76,
    gnarl: 0.08,
    branchCount: 24,
    rootCount: 7,
    rootSpread: 4.8,
    rootExposure: 0.1,
    foliageDensity: 1.12,
  },
  'tree-fern': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 27449,
    species: 'tree-fern',
    bolePlan: 'single',
    axisForm: 'sinuous',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.04,
    fluting: 0.04,
    rootRelief: 0.18,
    rootSurfacings: 0,
    lostLimbs: 0,
    lean: 4,
    sinuosity: 0.24,
    height: 9.5,
    crownRadius: 4.8,
    trunkRadius: 0.34,
    age: 0.64,
    gnarl: 0.1,
    branchCount: 18,
    rootCount: 6,
    rootSpread: 3.6,
    rootExposure: 0.16,
    foliageDensity: 1.04,
  },
  'quiver-tree': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 80687,
    species: 'quiver-tree',
    bolePlan: 'single',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.12,
    fluting: 0.1,
    rootRelief: 0.16,
    rootSurfacings: 0,
    lostLimbs: 0,
    lean: 2,
    sinuosity: 0.1,
    height: 8.5,
    crownRadius: 4.2,
    trunkRadius: 0.52,
    age: 0.74,
    gnarl: 0.14,
    branchCount: 5,
    rootCount: 6,
    rootSpread: 4,
    rootExposure: 0.12,
    foliageDensity: 1,
  },
  'doum-palm': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 46273,
    species: 'doum-palm',
    bolePlan: 'single',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.08,
    fluting: 0.08,
    rootRelief: 0.16,
    rootSurfacings: 0,
    lostLimbs: 0,
    lean: 3,
    sinuosity: 0.12,
    height: 16,
    crownRadius: 6.2,
    trunkRadius: 0.58,
    age: 0.8,
    gnarl: 0.12,
    branchCount: 6,
    rootCount: 7,
    rootSpread: 5.5,
    rootExposure: 0.14,
    foliageDensity: 1.05,
  },
  'joshua-tree': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 59113,
    species: 'joshua-tree',
    bolePlan: 'single',
    axisForm: 'sinuous',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.12,
    fluting: 0.12,
    rootRelief: 0.14,
    rootSurfacings: 0,
    lostLimbs: 0,
    lean: 4,
    sinuosity: 0.22,
    height: 9,
    crownRadius: 4.8,
    trunkRadius: 0.62,
    age: 0.76,
    gnarl: 0.26,
    branchCount: 5,
    rootCount: 6,
    rootSpread: 4.4,
    rootExposure: 0.12,
    foliageDensity: 1,
  },
  'bristlecone-pine': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 93557,
    species: 'bristlecone-pine',
    bolePlan: 'single',
    axisForm: 'sinuous',
    trunkDamage: 'snapped',
    crownForm: 'stagheaded',
    rootForm: 'buttressed',
    twist: 1.15,
    fluting: 0.65,
    rootRelief: 0.62,
    rootSurfacings: 1,
    lostLimbs: 5,
    lean: 12,
    sinuosity: 1.3,
    height: 11,
    crownRadius: 5.4,
    trunkRadius: 0.82,
    age: 0.98,
    gnarl: 0.95,
    branchCount: 6,
    rootCount: 7,
    rootSpread: 6.2,
    rootExposure: 0.7,
    foliageDensity: 0.48,
  },
  'screw-pine-pandanus': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 15991,
    species: 'screw-pine-pandanus',
    bolePlan: 'single',
    axisForm: 'leaning',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'stilted',
    twist: 0.22,
    fluting: 0.1,
    rootRelief: 1.6,
    rootSurfacings: 1,
    lostLimbs: 0,
    lean: 6,
    sinuosity: 0.18,
    height: 9,
    crownRadius: 4.4,
    trunkRadius: 0.42,
    age: 0.72,
    gnarl: 0.12,
    branchCount: 18,
    rootCount: 9,
    rootSpread: 4.8,
    rootExposure: 0.86,
    foliageDensity: 1.08,
  },
  banyan: {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 73133,
    species: 'banyan',
    bolePlan: 'codominant',
    axisForm: 'sinuous',
    trunkDamage: 'intact',
    crownForm: 'reiterated',
    rootForm: 'braided',
    twist: 0.42,
    fluting: 0.5,
    rootRelief: 0.82,
    rootSurfacings: 2,
    lostLimbs: 1,
    lean: 3,
    sinuosity: 0.42,
    height: 25,
    crownRadius: 18,
    trunkRadius: 1.4,
    age: 0.92,
    gnarl: 0.48,
    branchCount: 8,
    rootCount: 9,
    rootSpread: 13,
    rootExposure: 0.72,
    foliageDensity: 1.6,
  },
  mangrove: {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 42901,
    species: 'mangrove',
    bolePlan: 'multistem',
    axisForm: 'sinuous',
    trunkDamage: 'intact',
    crownForm: 'lopsided',
    rootForm: 'stilted',
    twist: 0.34,
    fluting: 0.38,
    rootRelief: 1.8,
    rootSurfacings: 2,
    lostLimbs: 1,
    lean: 7,
    sinuosity: 0.56,
    height: 12,
    crownRadius: 7,
    trunkRadius: 0.45,
    age: 0.8,
    gnarl: 0.42,
    branchCount: 7,
    rootCount: 10,
    rootSpread: 7,
    rootExposure: 0.95,
    foliageDensity: 1.1,
  },
  'strangler-fig': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 88741,
    species: 'strangler-fig',
    bolePlan: 'fused',
    axisForm: 'sinuous',
    trunkDamage: 'intact',
    crownForm: 'reiterated',
    rootForm: 'braided',
    twist: 2.2,
    fluting: 0.62,
    rootRelief: 1.25,
    rootSurfacings: 2,
    lostLimbs: 1,
    lean: 4,
    sinuosity: 0.48,
    height: 22,
    crownRadius: 11,
    trunkRadius: 1,
    age: 0.9,
    gnarl: 0.52,
    branchCount: 7,
    rootCount: 9,
    rootSpread: 9,
    rootExposure: 0.88,
    foliageDensity: 1.2,
  },
  'umbrella-acacia': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 24781,
    species: 'umbrella-acacia',
    bolePlan: 'single',
    axisForm: 'sinuous',
    trunkDamage: 'intact',
    crownForm: 'lopsided',
    rootForm: 'sunken',
    twist: 0.46,
    fluting: 0.22,
    rootRelief: 0.34,
    rootSurfacings: 1,
    lostLimbs: 2,
    lean: 6,
    sinuosity: 0.46,
    height: 12,
    crownRadius: 9,
    trunkRadius: 0.48,
    age: 0.82,
    gnarl: 0.52,
    branchCount: 6,
    rootCount: 6,
    rootSpread: 6,
    rootExposure: 0.28,
    foliageDensity: 0.82,
  },
  'rainbow-eucalyptus': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 61813,
    species: 'rainbow-eucalyptus',
    bolePlan: 'single',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'lopsided',
    rootForm: 'buttressed',
    twist: 0.28,
    fluting: 0.32,
    rootRelief: 0.42,
    rootSurfacings: 1,
    lostLimbs: 1,
    lean: 3,
    sinuosity: 0.18,
    height: 48,
    crownRadius: 10,
    trunkRadius: 1.15,
    age: 0.78,
    gnarl: 0.18,
    branchCount: 7,
    rootCount: 8,
    rootSpread: 8.5,
    rootExposure: 0.4,
    foliageDensity: 0.88,
  },
  'gum-eucalyptus': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 37511,
    species: 'gum-eucalyptus',
    bolePlan: 'codominant',
    axisForm: 'sinuous',
    trunkDamage: 'intact',
    crownForm: 'lopsided',
    rootForm: 'sunken',
    twist: 0.62,
    fluting: 0.18,
    rootRelief: 0.32,
    rootSurfacings: 1,
    lostLimbs: 2,
    lean: 8,
    sinuosity: 0.7,
    height: 24,
    crownRadius: 10,
    trunkRadius: 0.74,
    age: 0.78,
    gnarl: 0.46,
    branchCount: 7,
    rootCount: 7,
    rootSpread: 7.5,
    rootExposure: 0.3,
    foliageDensity: 0.68,
  },
  'giant-sequoia': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 96317,
    species: 'giant-sequoia',
    bolePlan: 'single',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'buttressed',
    twist: 0.16,
    fluting: 0.62,
    rootRelief: 0.54,
    rootSurfacings: 1,
    lostLimbs: 1,
    lean: 1,
    sinuosity: 0.05,
    height: 76,
    crownRadius: 12,
    trunkRadius: 3.4,
    age: 0.9,
    gnarl: 0.12,
    branchCount: 12,
    rootCount: 10,
    rootSpread: 14,
    rootExposure: 0.52,
    foliageDensity: 1.02,
  },
  'norfolk-island-pine': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 51437,
    species: 'norfolk-island-pine',
    bolePlan: 'single',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'sunken',
    twist: 0.08,
    fluting: 0.08,
    rootRelief: 0.16,
    rootSurfacings: 0,
    lostLimbs: 0,
    lean: 1,
    sinuosity: 0.04,
    height: 32,
    crownRadius: 7,
    trunkRadius: 0.62,
    age: 0.68,
    gnarl: 0.04,
    branchCount: 10,
    rootCount: 7,
    rootSpread: 6,
    rootExposure: 0.12,
    foliageDensity: 0.95,
  },
  'live-oak': {
    ...DEFAULT_TREE_PARAMETERS, seed: 82171, species: 'live-oak',
    bolePlan: 'single', axisForm: 'sinuous', trunkDamage: 'intact',
    crownForm: 'reiterated', rootForm: 'sunken', twist: 0.34,
    fluting: 0.72, rootRelief: 0.08, rootSurfacings: 0, lostLimbs: 0,
    lean: 3.5, sinuosity: 0.28, height: 20, crownRadius: 15,
    trunkRadius: 1.2, age: 0.94, gnarl: 0.58, branchCount: 7,
    rootCount: 5, rootSpread: 5.5, rootExposure: 0.03, foliageDensity: 1.42,
  },
  'european-beech': {
    ...DEFAULT_TREE_PARAMETERS, seed: 33049, species: 'european-beech',
    bolePlan: 'single', axisForm: 'straight', trunkDamage: 'intact',
    crownForm: 'full', rootForm: 'buttressed', twist: 0.18,
    // A beech's base is a buttress — a flare that widens into the ground —
    // not a spray of surface roots. The old exposure and spread ran eight
    // roots out across the litter and rendered as tentacles, which is the
    // one thing at eye level in a stand that nobody reads as a tree.
    fluting: 0.32, rootRelief: 0.3, rootSurfacings: 0, lostLimbs: 1,
    lean: 2, sinuosity: 0.12, height: 30, crownRadius: 10,
    trunkRadius: 0.86, age: 0.82, gnarl: 0.18, branchCount: 8,
    rootCount: 7, rootSpread: 5, rootExposure: 0.16, foliageDensity: 1.55,
  },
  'silver-birch': {
    ...DEFAULT_TREE_PARAMETERS, seed: 77419, species: 'silver-birch',
    bolePlan: 'multistem', axisForm: 'sinuous', trunkDamage: 'intact',
    crownForm: 'lopsided', rootForm: 'sunken', twist: 0.16,
    fluting: 0.08, rootRelief: 0.18, rootSurfacings: 0, lostLimbs: 1,
    lean: 5, sinuosity: 0.36, height: 19, crownRadius: 5.5,
    trunkRadius: 0.34, age: 0.62, gnarl: 0.22, branchCount: 8,
    rootCount: 6, rootSpread: 4.5, rootExposure: 0.12, foliageDensity: 0.86,
  },
  'cedar-of-lebanon': {
    ...DEFAULT_TREE_PARAMETERS, seed: 68227, species: 'cedar-of-lebanon',
    bolePlan: 'single', axisForm: 'sinuous', trunkDamage: 'intact',
    crownForm: 'reiterated', rootForm: 'buttressed', twist: 0.44,
    fluting: 0.46, rootRelief: 0.52, rootSurfacings: 1, lostLimbs: 2,
    lean: 3, sinuosity: 0.34, height: 27, crownRadius: 13,
    trunkRadius: 1.05, age: 0.9, gnarl: 0.54, branchCount: 7,
    rootCount: 8, rootSpread: 9, rootExposure: 0.48, foliageDensity: 0.84,
  },
  // Shrubs. Height and girth are the point: these sit in the two-to-four-metre
  // band the catalogue had nothing in, on stems a couple of centimetres thick.
  'hazel-thicket': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 30411,
    species: 'hazel-thicket',
    bolePlan: 'multistem',
    axisForm: 'sinuous',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'auto',
    height: 4.4,
    crownRadius: 2.5,
    trunkRadius: 0.05,
    age: 0.34,
    gnarl: 0.2,
    branchCount: 9,
    rootCount: 6,
    rootSpread: 1.7,
    rootExposure: 0.1,
    foliageDensity: 1.25,
    lean: 4,
    sinuosity: 0.6,
    lostLimbs: 0,
  },
  'elder-bush': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 51877,
    species: 'elder-bush',
    bolePlan: 'multistem',
    axisForm: 'sinuous',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'auto',
    height: 3.6,
    crownRadius: 2.2,
    trunkRadius: 0.06,
    age: 0.4,
    gnarl: 0.3,
    branchCount: 8,
    rootCount: 5,
    rootSpread: 1.5,
    rootExposure: 0.12,
    foliageDensity: 1.15,
    lean: 6,
    sinuosity: 0.72,
    lostLimbs: 0,
  },
  'common-juniper': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 62309,
    species: 'common-juniper',
    bolePlan: 'multistem',
    axisForm: 'straight',
    trunkDamage: 'intact',
    crownForm: 'full',
    rootForm: 'auto',
    // Squat and solid. A juniper's whole read is that it is far denser than
    // anything else its size; at 2.8 metres on a 1.1-metre radius it was a
    // spindle of bare canes with foliage hung on the outside of them.
    height: 1.9,
    crownRadius: 0.85,
    trunkRadius: 0.05,
    age: 0.52,
    gnarl: 0.34,
    branchCount: 11,
    rootCount: 5,
    rootSpread: 1,
    rootExposure: 0.08,
    foliageDensity: 1.75,
    lean: 3,
    sinuosity: 0.42,
    lostLimbs: 0,
  },
  'japanese-black-pine': {
    ...DEFAULT_TREE_PARAMETERS, seed: 14593, species: 'japanese-black-pine',
    bolePlan: 'single', axisForm: 'sinuous', trunkDamage: 'snapped',
    crownForm: 'lopsided', rootForm: 'buttressed', twist: 0.88,
    fluting: 0.42, rootRelief: 0.64, rootSurfacings: 2, lostLimbs: 4,
    lean: 14, sinuosity: 1.15, height: 14, crownRadius: 6.5,
    trunkRadius: 0.68, age: 0.9, gnarl: 0.88, branchCount: 6,
    rootCount: 7, rootSpread: 6.5, rootExposure: 0.64, foliageDensity: 0.58,
  },
}

export function normalizeTreeParameters(
  input: Partial<TreeParameters> | undefined,
): TreeParameters {
  const species = isTreeSpecies(input?.species)
    ? input.species
    : DEFAULT_TREE_PARAMETERS.species
  const fallback = TREE_SPECIES_PRESETS[species]
  return {
    seed: integerInRange(input?.seed, fallback.seed, 1, 0x7fffffff),
    species,
    bolePlan: oneOf(input?.bolePlan, BOLE_PLANS, fallback.bolePlan),
    axisForm: oneOf(input?.axisForm, AXIS_FORMS, fallback.axisForm),
    trunkDamage: oneOf(input?.trunkDamage, TRUNK_DAMAGE, fallback.trunkDamage),
    crownForm: oneOf(input?.crownForm, CROWN_FORMS, fallback.crownForm),
    rootForm: oneOf(input?.rootForm, ROOT_FORMS, fallback.rootForm),
    lean: finiteInRange(input?.lean, fallback.lean, 0, 35),
    sinuosity: finiteInRange(input?.sinuosity, fallback.sinuosity, 0, 3),
    twist: finiteInRange(input?.twist, fallback.twist, -6, 6),
    fluting: finiteInRange(input?.fluting, fallback.fluting, 0, 1),
    rootRelief: finiteInRange(input?.rootRelief, fallback.rootRelief, 0, 3),
    rootSurfacings: integerInRange(input?.rootSurfacings, fallback.rootSurfacings, 0, 5),
    lostLimbs: integerInRange(input?.lostLimbs, fallback.lostLimbs, 0, 8),
    // The floor was four metres, which predates both the shrubs and the
    // stumps. It was silently inflating a 1.9-metre juniper to 4 and a
    // 3.6-metre elder to 4 — the authored value never reached the generator —
    // and it made a stump unexpressible. It still guards the degenerate case
    // a floor is for: a zero or negative height.
    height: finiteInRange(input?.height, fallback.height, 1.2, 120),
    crownRadius: finiteInRange(input?.crownRadius, fallback.crownRadius, 1.5, 35),
    // The floor is a sapling's stem, not a tree's. Twelve centimetres of
    // radius is a quarter-metre bole, which no four-metre plant has; holding
    // the floor there meant a juvenile recipe could only ever be a stubby
    // post, however young its architecture was.
    trunkRadius: finiteInRange(input?.trunkRadius, fallback.trunkRadius, 0.03, 8),
    age: finiteInRange(input?.age, fallback.age, 0, 1),
    gnarl: finiteInRange(input?.gnarl, fallback.gnarl, 0, 1),
    branchCount: integerInRange(input?.branchCount, fallback.branchCount, 5, 30),
    rootCount: integerInRange(input?.rootCount, fallback.rootCount, 5, 10),
    rootSpread: finiteInRange(input?.rootSpread, fallback.rootSpread, 3, 16),
    rootExposure: finiteInRange(input?.rootExposure, fallback.rootExposure, 0, 1),
    foliageDensity: finiteInRange(
      input?.foliageDensity,
      fallback.foliageDensity,
      0,
      MAX_FOLIAGE_DENSITY,
    ),
  }
}

const BOLE_PLANS = [
  'auto', 'single', 'codominant', 'multistem', 'fused',
] as const satisfies readonly TreeBolePlan[]
const AXIS_FORMS = [
  'auto', 'straight', 'leaning', 'sinuous',
] as const satisfies readonly TreeAxisForm[]
const TRUNK_DAMAGE = [
  'auto', 'intact', 'snapped',
] as const satisfies readonly TreeTrunkDamage[]
const CROWN_FORMS = [
  'auto', 'full', 'stagheaded', 'lopsided', 'reiterated',
] as const satisfies readonly TreeCrownForm[]
const ROOT_FORMS = [
  'auto', 'braided', 'buttressed', 'stilted', 'sunken',
] as const satisfies readonly TreeRootForm[]

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function finiteInRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, value as number))
}

function integerInRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.round(finiteInRange(value, fallback, minimum, maximum))
}
