import type { SurfaceRecipe } from '../bake'
import { alpineCliffRockRecipe } from './alpineCliffRock'
import { cliffSideRecipe } from './cliffSide'
import { emberFaultRockRecipe } from './emberFaultRock'
import { rockGroundRecipe } from './rockGround'

export const PROCEDURAL_SURFACES = {
  'rock-ground': rockGroundRecipe,
  'cliff-side': cliffSideRecipe,
  'alpine-cliff-rock': alpineCliffRockRecipe,
  'ember-fault-rock': emberFaultRockRecipe,
} as const satisfies Record<string, SurfaceRecipe>

export type ProceduralSurfaceId = keyof typeof PROCEDURAL_SURFACES

export { alpineCliffRockRecipe, cliffSideRecipe, emberFaultRockRecipe, rockGroundRecipe }
