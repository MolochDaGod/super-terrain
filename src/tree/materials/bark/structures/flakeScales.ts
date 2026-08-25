import { hash2, positiveModulo, smooth01 } from '../../proceduralNoise'

/**
 * One texel's worth of an overlapping bark-scale field.
 *
 * `identity` and `age` are deliberately two independent hashes of the same
 * cell. Bark scales differ from their neighbours in two unrelated ways — the
 * cork itself is a different tint, and it has been exposed for a different
 * length of time — and collapsing both onto one number makes every pale scale
 * also the warmest one, which reads as a colour ramp rather than as a wall of
 * individually weathered flakes.
 */
export interface FlakeSample {
  /** Surface height of the flake that wins this texel. Steps at every lip. */
  height: number
  /** 1 on a scale lip, falling to 0 across the face. */
  edge: number
  /**
   * How far the winning flake stands *below* its nearest rival, 0..1. This is
   * the shadow term: a scale that is overlapped by its neighbour carries a
   * hard dark line along the shared edge, and one that overlaps it does not.
   */
  undercut: number
  identity: number
  age: number
  /** 0 at the middle of the winning flake, 1 at its rim. */
  rim: number
}

/**
 * A field of overlapping cork scales.
 *
 * The usual procedural bark primitive is a Voronoi border used as a crack
 * network: every cell is outlined, every outline is the same darkness, and the
 * surface between them is one continuous smooth sheet. That is why it renders
 * as reptile skin — it has the topology of bark and none of its construction.
 *
 * Real mature bark is not a sheet with cracks in it. It is a pile of discrete
 * scales, each lying at its own height, each overlapping some neighbours and
 * lying under others. So this field gives every cell a random height offset
 * and takes the *maximum* of the lifted distance fields rather than the
 * distance to a border. The height is then genuinely discontinuous at every
 * boundary where two scales differ, which is what produces the hard lit lip on
 * one side and the hard shadow on the other — the whole read of the reference
 * photographs, and something a symmetric crack groove cannot produce at any
 * depth.
 *
 * `columns` and `rows` are cell counts across the tile, so the caller controls
 * the scale aspect directly; the tile is periodic in both.
 */
export function sampleFlakeScales(
  /**
   * Written in place. Two million texels times two tiers is four million short-
   * lived objects a bake, which the collector spends longer on than the field
   * pass spends computing them; the caller keeps one scratch per tier instead.
   */
  out: FlakeSample,
  u: number,
  v: number,
  columns: number,
  rows: number,
  seed: number,
  /** Spread of the per-scale height offsets, in relief units. */
  lift = 0.55,
  /** How far a scale's own face domes above its rim. */
  dome = 0.3,
): void {
  const countX = Math.max(2, Math.round(columns))
  const countY = Math.max(2, Math.round(rows))
  const x = u * countX + 5.7
  const y = v * countY - 2.3

  let bestField = -Infinity
  let secondField = -Infinity
  let bestLift = 0
  let secondLift = 0
  let bestCellX = 0
  let bestCellY = 0
  let bestDistance = 0

  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    const sourceY = Math.floor(y) + offsetY
    const wrappedY = positiveModulo(sourceY, countY)
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const sourceX = Math.floor(x) + offsetX
      const wrappedX = positiveModulo(sourceX, countX)
      // One hash, three uses. The feature offset and the height offset are
      // independent enough taken from different bit ranges of a single 32-bit
      // draw, and this loop runs nine times per texel on a two-megapixel map:
      // three hashes a cell rather than one is not a detail here, it is most of
      // the bake.
      const draw = hash2(wrappedX, wrappedY, seed + 83)
      const packed = Math.floor(draw * 16777216)
      const featureX = sourceX + 0.16 + ((packed & 255) / 255) * 0.68
      const featureY = sourceY + 0.16 + (((packed >> 8) & 255) / 255) * 0.68
      const dx = featureX - x
      const dy = featureY - y
      const distance = Math.sqrt(dx * dx + dy * dy)
      // The per-scale offset enters the distance field, not the height after
      // the fact. Adding it afterwards would leave every boundary sitting on
      // the unweighted bisector, and a scale that stands proud would still
      // stop dead on a line drawn as if it did not — the overlap has to move
      // the boundary, or the surface reads as painted tiles.
      const scaleLift = ((packed >> 16) & 255) / 255
      const field = scaleLift * lift - distance
      if (field > bestField) {
        secondField = bestField
        secondLift = bestLift
        bestField = field
        bestLift = scaleLift
        bestCellX = wrappedX
        bestCellY = wrappedY
        bestDistance = distance
      } else if (field > secondField) {
        secondField = field
        secondLift = scaleLift
      }
    }
  }

  const separation = bestField - secondField
  // Normalised, so `height` always spans 0..1 whatever the caller asked for.
  // Returning it in the caller's own lift units meant every amplitude
  // downstream silently changed meaning when a profile's `scaleLift` moved,
  // and the exposure term built on it quietly saturated across whole species —
  // which is a calibration failure that looks exactly like an art problem.
  const span = Math.max(1e-6, lift + dome)
  // A lip a couple of texels wide is a hairline; one that ramps over a fifth
  // of a cell is a chamfer with a face the light can catch.
  const edge = 1 - smooth01(separation / 0.22)
  // A narrow chamfer, not a dome. Ramping the face up over a third of the cell
  // makes every scale a rounded pad with a valley all the way round it, and a
  // field of those reads as cobbles or as crocodile hide — the same outlined
  // look the crack network gave, arrived at through relief instead of colour.
  // Real cork scales are flat facets that meet in a step, so the rise has to
  // happen within a few texels of the rim and the rest of the face stay level.
  const pad = smooth01(separation / 0.1)
  out.height = (bestLift * lift + pad * dome) / span
  out.edge = edge
  // Raised to a power rather than used directly. A linear step darkens
  // essentially every boundary, because two random lifts differ by a third of
  // the range on average — and a surface where every scale is outlined is the
  // crack network this structure exists to replace, drawn in shadow instead of
  // in albedo. Only the genuinely overlapped edges should read.
  out.undercut = edge * Math.pow(Math.max(0, secondLift - bestLift), 2.2)
  out.identity = hash2(bestCellX, bestCellY, seed + 97)
  out.age = hash2(bestCellX, bestCellY, seed + 3571)
  out.rim = Math.min(1, bestDistance / 0.7)
}

/** A zeroed sample, for a caller that needs a scratch to write into. */
export function emptyFlakeSample(): FlakeSample {
  return { height: 0, edge: 0, undercut: 0, identity: 0.5, age: 0.5, rim: 0 }
}
