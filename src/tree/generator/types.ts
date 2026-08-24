export interface TreeVec3 {
  x: number
  y: number
  z: number
}

export type TreeSpecies = 'ancient-oak' | 'field-oak' | 'windswept-pine'
export type TreePartType = 'trunk' | 'branch' | 'root' | 'twig'
export type TreeJunctionType =
  | 'root-flare'
  | 'continuation'
  | 'lateral'
  | 'bifurcation'
  | 'terminal'

/**
 * Structural forms an individual can take. `auto` lets the seed decide, which
 * is what a whole forest wants; naming one pins it, which is what authoring a
 * specific hero tree wants.
 */
export type TreeBoleForm =
  | 'auto'
  | 'straight'
  | 'leaning'
  | 'sinuous'
  | 'codominant'
  | 'snapped'
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
  /** Which structural forms this individual takes. `auto` defers to the seed. */
  boleForm: TreeBoleForm
  crownForm: TreeCrownForm
  rootForm: TreeRootForm
  /** How far the bole leans from vertical, in degrees. */
  lean: number
  /** Depth of the bole's own S-curve, in trunk radii. */
  sinuosity: number
  /** Spiral grain: how far the cross section turns over the bole, in turns. */
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
  /** Buttress ribs at this station. Shared by reference along a member. */
  fins?: readonly TreeButtressFin[]
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
  seed: number
}

export interface SemanticTreeGraph {
  seed: number
  parts: SemanticTreePart[]
  contacts: TreeContact[]
  foliageClusters: FoliageCluster[]
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

export interface TreeFoliageData {
  representation: FoliageRepresentation
  matrices: Float32Array
  colors: Float32Array
  /** Atlas spray each card draws. Cards are batched one instanced mesh per variant. */
  variants: Uint8Array
  variantCount: number
  count: number
}

export interface TreeLodAsset {
  level: TreeLodLevel
  wood: TreeMeshData
  foliage: TreeFoliageData
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
  boleForm: 'auto',
  crownForm: 'auto',
  rootForm: 'auto',
  lean: 6,
  sinuosity: 0.55,
  twist: 0.5,
  fluting: 0.6,
  rootRelief: 1.2,
  rootSurfacings: 2,
  lostLimbs: 3,
  height: 22,
  crownRadius: 13.5,
  trunkRadius: 1.05,
  age: 0.9,
  gnarl: 0.72,
  branchCount: 10,
  rootCount: 7,
  rootSpread: 9.5,
  rootExposure: 0.5,
  foliageDensity: 0.88,
}

export const TREE_SPECIES_PRESETS: Record<TreeSpecies, TreeParameters> = {
  'ancient-oak': DEFAULT_TREE_PARAMETERS,
  'field-oak': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 31591,
    species: 'field-oak',
    height: 21,
    crownRadius: 9,
    trunkRadius: 0.52,
    age: 0.58,
    gnarl: 0.36,
    branchCount: 11,
    rootCount: 6,
    rootSpread: 7,
    rootExposure: 0.42,
    foliageDensity: 0.9,
  },
  'windswept-pine': {
    ...DEFAULT_TREE_PARAMETERS,
    seed: 71023,
    species: 'windswept-pine',
    height: 29,
    crownRadius: 6.2,
    trunkRadius: 0.46,
    age: 0.66,
    gnarl: 0.44,
    branchCount: 13,
    rootCount: 7,
    rootSpread: 6.8,
    rootExposure: 0.48,
    foliageDensity: 0.7,
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
    boleForm: oneOf(input?.boleForm, BOLE_FORMS, fallback.boleForm),
    crownForm: oneOf(input?.crownForm, CROWN_FORMS, fallback.crownForm),
    rootForm: oneOf(input?.rootForm, ROOT_FORMS, fallback.rootForm),
    lean: finiteInRange(input?.lean, fallback.lean, 0, 35),
    sinuosity: finiteInRange(input?.sinuosity, fallback.sinuosity, 0, 3),
    twist: finiteInRange(input?.twist, fallback.twist, -2, 2),
    fluting: finiteInRange(input?.fluting, fallback.fluting, 0, 1),
    rootRelief: finiteInRange(input?.rootRelief, fallback.rootRelief, 0, 3),
    rootSurfacings: integerInRange(input?.rootSurfacings, fallback.rootSurfacings, 0, 5),
    lostLimbs: integerInRange(input?.lostLimbs, fallback.lostLimbs, 0, 8),
    height: finiteInRange(input?.height, fallback.height, 10, 45),
    crownRadius: finiteInRange(input?.crownRadius, fallback.crownRadius, 3, 20),
    trunkRadius: finiteInRange(input?.trunkRadius, fallback.trunkRadius, 0.18, 1.6),
    age: finiteInRange(input?.age, fallback.age, 0, 1),
    gnarl: finiteInRange(input?.gnarl, fallback.gnarl, 0, 1),
    branchCount: integerInRange(input?.branchCount, fallback.branchCount, 5, 15),
    rootCount: integerInRange(input?.rootCount, fallback.rootCount, 5, 10),
    rootSpread: finiteInRange(input?.rootSpread, fallback.rootSpread, 3, 16),
    rootExposure: finiteInRange(input?.rootExposure, fallback.rootExposure, 0, 1),
    foliageDensity: finiteInRange(
      input?.foliageDensity,
      fallback.foliageDensity,
      0,
      1,
    ),
  }
}

const BOLE_FORMS = [
  'auto', 'straight', 'leaning', 'sinuous', 'codominant', 'snapped',
] as const satisfies readonly TreeBoleForm[]
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

function isTreeSpecies(value: unknown): value is TreeSpecies {
  return value === 'ancient-oak' || value === 'field-oak' || value === 'windswept-pine'
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
