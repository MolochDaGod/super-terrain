import { normalize, TreeRandom, vec3 } from '../math'
import type { SemanticTreePart, TreeParameters } from '../types'
import { growApicalDichotomy, type Apex } from './apicalDichotomy'
import { axisDirection } from './axis'
import { dichotomyPolicy, initialSplitPlane } from './profiles/dichotomousProfiles'
import type { GrowthRegimeResult } from './types'

/**
 * Repeated apical division: dragon's blood, quiver, Joshua and doum.
 *
 * This regime owns nothing but the handover from the bole to the first apex.
 * The mechanism lives in `apicalDichotomy`, and what each species does with it
 * lives in its own policy, because the four are genuinely different grammars
 * rather than one binary tree with four sets of angles.
 */
export function growDichotomousCrown(
  parameters: TreeParameters,
  trunk: SemanticTreePart,
  random: TreeRandom,
): GrowthRegimeResult {
  const top = trunk.spine.at(-1)!
  const policy = dichotomyPolicy(parameters, {
    boleTop: top.position.y,
    boleRadius: top.radius,
    ceiling: parameters.height,
    reach: parameters.crownRadius,
    centreX: top.position.x,
    centreZ: top.position.z,
  })
  const direction = normalize(axisDirection(trunk.spine), vec3(0, 1, 0))
  const start: Apex = {
    id: 'dichotomy',
    parentId: trunk.id,
    attachment: 1,
    position: top.position,
    direction,
    splitPlane: initialSplitPlane(direction, parameters.seed),
    radius: policy.initialRadius(top.radius, random),
    generation: 0,
    internode: 0,
    vigor: 1,
    damaged: false,
    continuation: true,
    branchOrder: 1,
  }
  return growApicalDichotomy(start, policy, random, parameters.crownRadius)
}
