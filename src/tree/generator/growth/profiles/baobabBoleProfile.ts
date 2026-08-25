import { clamp, hashUnit, lerpNumber, smoothstep } from '../../math'
import { fusedStemRing, type FusedStemLobe } from '../../fusedStems'

export interface BaobabBoleStation {
  radiusMultiplier: number
  radiusXScale: number
  radiusZScale: number
  rotation: number
  lobeCount: number
  lobeStrength: number
  fusedStems: readonly FusedStemLobe[]
  fusedStemBlend: number
}

/**
 * Maximum centre-line wave amplitude before a massive bole's swept surface
 * folds through itself. The limit follows the curvature of a sinusoid and the
 * local trunk radius, so an edited high-sinuosity variant remains valid.
 */
export function baobabMeanderAmplitudeLimit(
  boleHeight: number,
  trunkRadius: number,
  turns: number,
): number {
  const wave = Math.max(0.5, Math.PI * 2 * turns)
  return Math.max(0.025, (boleHeight * boleHeight * 0.32) /
    (Math.max(0.2, trunkRadius) * wave * wave))
}

/**
 * Number of stems fused into one bole for a given individual.
 *
 * Adansonia routinely germinates as, or reverts to, a cluster of stems which
 * grow into contact and merge. That is the whole reason a baobab bole is lumpy
 * rather than round, and reproducing it as an *outline* rather than as surface
 * noise is what separates it from a lathed vase.
 */
export function baobabFusedStemCount(seed: number): number {
  const identity = hashUnit(seed ^ 0x13579bdf, 1.7, 0.29, 3.1)
  // Three or four broad columns read as fused stems. Five or more start to look
  // like fluting on a turned column, which is the failure this replaced.
  return identity < 0.42 ? 3 : identity < 0.86 ? 4 : 5
}

/**
 * Macro anatomy of an old African baobab bole.
 *
 * Three things had to change from the rejected lathed-bottle version. The bole
 * no longer pinches to a neck — it stays thick right up to the divisions, which
 * is what makes those divisions read as trunk-scale limbs instead of pipes
 * pushed into a vase. The base spreads into broad shoulders across the whole
 * stretch that is actually above grade, rather than into a decorative foot that
 * the buried butt hid entirely. And the plan is a union of fused stems, so the
 * silhouette has real vertical folds and an uneven outline at every height.
 */
export function baobabBoleStation(
  t: number,
  seed: number,
  age: number,
  metresAboveGrade: number,
  trunkRadius: number,
): BaobabBoleStation {
  const u = clamp(t, 0, 1)
  const identity = hashUnit(seed ^ 0x5f4b2a19, 0.37, 1.91, 0.73)
  const upperIdentity = hashUnit(seed ^ 0x21c86d3b, 2.13, 0.44, 1.27)

  // Massive through the storage bole and still massive where it divides. A
  // baobab's first fork is around two thirds of its greatest girth, not the
  // two-fifths a generic bottle taper produces.
  const columnMass = lerpNumber(0.94, 1.04, identity)
  const forkMass = lerpNumber(0.7, 0.79, upperIdentity)
  const shoulder = smoothstep(0.55, 1, u)
  // The butt is buried, so a flare measured against the very bottom of the
  // sweep is entirely below grade. This one runs the full lower third and is
  // still opening where the tree actually meets the ground.
  const shoulders = Math.pow(smoothstep(0.42, 0, u), 1.35) *
    lerpNumber(0.28, 0.4, age)
  // A second, much tighter flare placed in *metres* around the ground line.
  // The broad shoulders above are a fraction of the bole's height, so on a tall
  // individual they open too slowly to read at all from standing height — which
  // is exactly how the base came out as a vertical wall meeting flat terrain.
  const foot = Math.pow(
    smoothstep(trunkRadius * 0.85, -trunkRadius * 0.7, metresAboveGrade),
    1.4,
  ) * lerpNumber(0.15, 0.27, age)
  // Wide, slow bulges: the elephant-hide swelling of a water-storing bole,
  // rather than the high-frequency ripple that reads as a turned ornament.
  const swelling =
    Math.sin(u * Math.PI * 1.7 + identity * 5.7) * 0.055 * Math.sin(u * Math.PI) +
    Math.sin(u * Math.PI * 3.1 + upperIdentity * 4.1) * 0.026 * Math.sin(u * Math.PI)
  const radiusMultiplier =
    lerpNumber(columnMass, forkMass, Math.pow(shoulder, 1.25)) +
    shoulders + foot + swelling

  // Fusion is deepest at the base, where the stems met first and the shoulders
  // run out into roots, and shallowest at the fork, where the bole has grown
  // into one mass. The whole plan also rotates slowly with height, so the folds
  // spiral instead of running as four straight grooves up a column.
  const stemCount = baobabFusedStemCount(seed)
  // Reverted from the deeper v11 setting. Bole-shape tuning is not the open
  // problem, and pushing the stems further apart only widened the range over
  // which the union outline could become ill-conditioned.
  const spread = lerpNumber(0.36, 0.19, smoothstep(0.06, 0.86, u)) *
    lerpNumber(0.82, 1.1, age)
  const unevenness = lerpNumber(0.46, 0.22, smoothstep(0.1, 0.9, u))
  const rotation = u * lerpNumber(0.34, 0.62, identity) + identity * 2.4
  const fusedStems = fusedStemRing(
    stemCount,
    spread,
    unevenness,
    rotation,
    // Per-stem identity only. Feeding the station height into this hash gave
    // every ring an independently random set of lobes, so the bole's outline
    // jittered from station to station: a noisy surface with hard horizontal
    // ledges where two neighbouring rings happened to disagree. Height enters
    // the outline through `spread`, `unevenness` and `rotation`, all of which
    // are continuous.
    (index) => hashUnit(seed ^ 0x2545f491, index * 0.5 + 0.25, 1.37, index * 1.3),
  )

  return {
    radiusMultiplier,
    // The union already carries the plan's asymmetry; an ellipse on top of it
    // only squashes the folds on two sides.
    radiusXScale: 1,
    radiusZScale: 1,
    rotation: 0,
    lobeCount: stemCount,
    lobeStrength: 0,
    fusedStems,
    // Sharper low down where the stems are still distinct, softening upward.
    fusedStemBlend: lerpNumber(0.03, 0.08, smoothstep(0.15, 0.9, u)),
  }
}
