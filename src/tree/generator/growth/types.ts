import type { TreeOrganModel } from '../speciesCatalog'
import type { TreeVec3 } from '../types'

export interface GrowthAxisSample {
  position: TreeVec3
  radius: number
  /**
   * Local girth multiplier for reaction wood, chiefly around a division.
   *
   * Carried on the sample rather than folded into `radius` so the taper stays
   * readable and the swelling remains a property of the node.
   */
  swell?: number
  /** Cross-section flattening across `flattenAxis`, 0 for round wood. */
  flatten?: number
  flattenAxis?: TreeVec3
}

/** A regime-neutral woody axis which semanticGraph turns into a swept part. */
export interface GrowthAxisDraft {
  id: string
  parentId: string
  attachment: number
  branchOrder: number
  continuation: boolean
  /** The axis opens inside its parent; the mesher must not build a collar. */
  embedded?: boolean
  samples: GrowthAxisSample[]
}

/** A botanical organ station; the compiler chooses cards, rosettes or fronds. */
export interface OrganStationDraft {
  partId: string
  center: TreeVec3
  axis: TreeVec3
  radius: number
  depth: number
  occlusion: number
  /** 0 for a live expanding organ, 1 for a retained dry/dead organ. */
  senescence?: number
  /** 0 for a tightly folded spear leaf, 1 for a fully expanded organ. */
  development?: number
  organModel: TreeOrganModel
  seed: number
}

/** A pendant bunch of individually instanced fleshy fruit. */
export interface FruitClusterDraft {
  model: 'date-bunch' | 'coconut-cluster'
  partId: string
  center: TreeVec3
  axis: TreeVec3
  /** First rachilla direction; fruit placement rotates around this basis. */
  radial: TreeVec3
  strandCount: number
  spread: number
  length: number
  fruitRadius: number
  count: number
  seed: number
}

export interface GrowthRegimeResult {
  axes: GrowthAxisDraft[]
  organs: OrganStationDraft[]
  fruits?: FruitClusterDraft[]
}
