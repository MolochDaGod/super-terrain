import { TreeRandom } from '../math'
import { treeSpeciesDefinition } from '../speciesCatalog'
import type { SemanticTreePart, TreeParameters } from '../types'
import { growApicalCrown } from './apicalCrown'
import { growBaobabCrown } from './baobabGrowth'
import { growDichotomousCrown } from './dichotomousGrowth'
import { growExplicitScaffold } from './explicitScaffold'
import type { GrowthRegimeResult } from './types'
import { growWhorledCrown } from './whorledGrowth'

export function growRegimeCrown(
  parameters: TreeParameters,
  trunk: SemanticTreePart,
  random: TreeRandom,
): GrowthRegimeResult {
  switch (treeSpeciesDefinition(parameters.species).growthModel) {
    case 'explicit-scaffold':
      return growExplicitScaffold(parameters, trunk, random)
    case 'baobab-crown':
      return growBaobabCrown(parameters, trunk, random)
    case 'recursive-dichotomy':
      return growDichotomousCrown(parameters, trunk, random)
    case 'monopodial-whorls':
      return growWhorledCrown(parameters, trunk, random)
    case 'apical-frond':
      return growApicalCrown(parameters, trunk, random)
    case 'colonized-crown':
      return { axes: [], organs: [] }
  }
}
