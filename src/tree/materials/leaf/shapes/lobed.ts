import { cellularBorder, clamp01, hash2, mix, smooth01 } from '../../proceduralNoise'
import type { BladeShape } from './types'

/** One rounded lobe, described by its crown rather than by its sinus. */
interface Lobe {
  /** Position of the lobe apex along the blade, 0 = base, 1 = tip. */
  apexAt: number
  /** Half-extent of the crown along the blade. Narrower cuts deeper sinuses. */
  crownSpan: number
  /** How far this lobe reaches out relative to its neighbours. */
  prominence: number
}

/**
 * English oak: obovate, three to six irregular rounded lobe pairs, sinuses
 * cutting well toward the midrib, widest above the middle.
 *
 * Lobe positions are irregular *and* differ between the two halves. Perfect
 * bilateral symmetry and an even lobe cadence are the two clearest procedural
 * tells a leaf can carry: a real oak sets the lobes on one side between those
 * on the other, gives no two the same depth, and usually carries an extra on
 * one half.
 */
export function lobedShape(
  variation: number,
  aspect: number,
  lobePairs: readonly [number, number],
): BladeShape {
  const seed = Math.round(variation * 65_536)
  const sides = [buildLobes(seed, 0, lobePairs), buildLobes(seed, 1, lobePairs)]

  const halfWidth = (u: number, side: number): number => {
    if (u < 0) return 0
    if (u > 1) return 0
    return aspect * envelope(u) * lobing(u, sides[side < 0 ? 0 : 1]!)
  }

  let reach = 0
  for (let step = 0; step <= 64; step += 1) {
    const u = step / 64
    reach = Math.max(reach, halfWidth(u, 1), halfWidth(u, -1))
  }

  return {
    halfWidth,
    reach,
    stalkHalfWidth: aspect * 0.055,
    veins(u, v, side) {
      const lobes = sides[side < 0 ? 0 : 1]!
      // The rib narrows toward the apex, as a real midrib tapers out. Wide
      // enough that its Gaussian shoulder is several texels at card
      // resolution: a rib narrower than the filter reads as a scored line.
      const ribWidth = aspect * mix(0.075, 0.03, u)
      const midrib = Math.exp(-((v / ribWidth) ** 2))

      // Every secondary is aimed at a lobe apex, so the venation and the
      // outline agree. Veins drawn on their own frequency cross the sinuses
      // and read as a printed pattern laid over the leaf.
      let lateral = 0
      for (const lobe of lobes) {
        const apex = lobe.apexAt
        const tip = halfWidth(apex, side) * 0.94
        // The secondary leaves the rib below its lobe and climbs to the apex.
        const rootAt = apex - 0.17
        const t = clamp01((u - rootAt) / Math.max(1e-3, apex - rootAt))
        // A real secondary leaves the midrib steeply and then bends over toward
        // the lobe apex. Running it as a straight chord instead gives a fan of
        // identical diagonals across every blade, which reads as machined
        // hatching rather than as venation.
        const line = Math.pow(t, 0.66) * tip * Math.sign(v || 1)
        const along = Math.abs(v - line)
        const thickness = aspect * mix(0.046, 0.019, t)
        // Fade the vein out past its own apex rather than cutting it off.
        const live = smooth01((u - rootAt + 0.06) / 0.06) *
          smooth01((apex + 0.1 - u) / 0.09)
        lateral = Math.max(lateral, Math.exp(-((along / thickness) ** 2)) * live)
      }

      // Tertiary reticulation: the areole mesh between the secondaries. Low
      // contrast on purpose — it exists to stop the intercostal fields reading
      // as flat paint, not to be legible as a net — but it does have to be
      // there. A blade with no structure between its veins has a glassy vinyl
      // surface that no roughness value can rescue.
      //
      // It has to be *irregular*. Two multiplied sines are the cheap way to get
      // a mesh and they produce a perfectly periodic moiré that reads as woven
      // corduroy running diagonally across every blade — a far louder artefact
      // than the flatness it was added to fix. A jittered cell network gives
      // the closed, uneven polygons real venation actually encloses.
      const border = cellularBorder(u * RETICULATION, v * RETICULATION / aspect,
        0x51f7, 4096, 4096, 0.9)
      const reticulate = clamp01(1 - border * 9) * (1 - midrib) * (1 - lateral)

      return { midrib, lateral, reticulate }
    },
  }
}

/**
 * The obovate body: narrow at the base, widest around 60% of the way up, and
 * blunt at the apex. Widest-above-the-middle is the cue that separates an oak
 * from a maple, and a rounded apex separates it from a chestnut or a willow.
 */
function envelope(u: number): number {
  const belly = 1 - 0.2 * ((u - 0.6) / 0.6) ** 2
  return clamp01(belly * apexCap(u)) * auricles(u)
}

/**
 * A circular cap over the last sixth of the blade.
 *
 * An oak apex is *obtuse* — a broad round dome, often barely distinguishable
 * from the terminal lobe. Closing the outline with a smoothstep instead tapers
 * the last twenty percent to a fine point, and a pointed apex reads as willow
 * or bamboo no matter how correct the lobes below it are. It was the single
 * wrongest note in the first outline.
 */
function apexCap(u: number): number {
  if (u <= 0.9) return 1
  const t = (u - 0.9) / 0.105
  return Math.sqrt(Math.max(0, 1 - t * t))
}

/**
 * The basal ears. A real oak blade pinches to a very short petiole and then
 * flares into two small rounded auricles that clasp the stalk, with a slight
 * constriction above them before the lamina widens. The shape this replaced
 * tapered the base to a single point, which read as a spearhead.
 */
function auricles(u: number): number {
  if (u >= 0.22) return 1
  const rise = smooth01((u - 0.004) / 0.19)
  const ear = 0.42 * Math.exp(-(((u - 0.045) / 0.03) ** 2))
  return clamp01(rise + ear)
}

/** How much half-width survives at the deepest sinus. */
const SINUS_FLOOR = 0.22

/**
 * Modulates the body by the lobe train.
 *
 * The train is described by its *crowns*, not by its sinuses. Subtracting
 * narrow notches from a full-width body is the obvious way round and it is
 * wrong: a notch deep enough to read as an oak sinus is also narrow enough to
 * come to a visible V, so the rim ends up a row of sharp teeth. Adding wide,
 * overlapping raised cosines instead makes both halves of the profile round by
 * construction — a convex crown at each lobe and a smooth floor where two
 * neighbouring crowns fall away together, which is exactly the anatomy.
 */
function lobing(u: number, lobes: readonly Lobe[]): number {
  // Below the lowest lobe the train has fallen away, but the base of the blade
  // is not pinched to a thread — the auricles live down there. Filling the
  // crown field back in lets the envelope own that end of the outline.
  let crown = smooth01((0.19 - u) / 0.15)
  for (const lobe of lobes) {
    const t = (u - lobe.apexAt) / lobe.crownSpan
    if (t <= -1 || t >= 1) continue
    crown += (0.5 + 0.5 * Math.cos(Math.PI * t)) * lobe.prominence
  }
  return SINUS_FLOOR + (1 - SINUS_FLOOR) * clamp01(crown)
}

/**
 * Areoles per blade length. Fine enough to read as surface, coarse enough to
 * stay above a texel at card resolution — a mesh finer than the filter is just
 * shimmer waiting for the first mip.
 */
const RETICULATION = 22

/** Where the lowest and highest lobe crowns sit along the blade. */
const FIRST_LOBE = 0.17
const LAST_LOBE = 0.88

function buildLobes(
  seed: number,
  side: number,
  [minPairs, maxPairs]: readonly [number, number],
): Lobe[] {
  const count = minPairs +
    Math.floor(hash2(seed, side * 31 + 7, 0x51ed) * (maxPairs - minPairs + 1))
  const lobes: Lobe[] = []
  const spacing = (LAST_LOBE - FIRST_LOBE) / Math.max(1, count - 1)
  // Offset one half against the other so the lobes interleave across the rib.
  const phase = (0.32 * side + hash2(seed, side, 0x2f19) * 0.28) * spacing
  for (let index = 0; index < count; index += 1) {
    const jitterA = hash2(seed, index * 13 + side * 101, 0x77a1)
    const jitterB = hash2(seed, index * 29 + side * 211, 0x1c4d)
    const apexAt = FIRST_LOBE + index * spacing + phase + (jitterA - 0.5) * spacing * 0.3
    // Around two thirds of the spacing puts the sinus floor near half the
    // half-width, which is the depth an English oak actually cuts to. Varying
    // it per lobe is what stops the train reading as a machined gear.
    const reachOut = Math.sin(clamp01((apexAt - 0.05) / 0.9) * Math.PI)
    lobes.push({
      apexAt,
      crownSpan: spacing * (0.6 + jitterB * 0.22),
      // The middle lobes of an oak blade are the biggest; the basal pair is
      // always small and the terminal one merges into the apex.
      prominence: mix(0.72, 1.12, reachOut) * (0.86 + jitterA * 0.24),
    })
  }
  return lobes
}
