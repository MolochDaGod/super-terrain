/**
 * Cross-sections built as the union of several offset stems.
 *
 * An ellipse with a cosine ripple can only ever be a lathed column with
 * fluting. It cannot produce the shape a baobab, a banyan or a strangler fig
 * actually has, because those boles are not one stem that grew ridges: they are
 * several stems, or several root columns, that grew into contact and fused. The
 * plan of such a bole is a union of overlapping discs, with real concave folds
 * where two members meet and a genuinely uneven outline.
 *
 * Evaluating that union directly is both cheaper and more honest than trying to
 * approximate it with harmonics, and it reuses the same idea as the junction
 * blend one order of magnitude smaller: a soft union of round primitives.
 */

/** One stem in a fused column, in units of the member's nominal radius. */
export interface FusedStemLobe {
  /** Offset of this stem's centre from the member axis. */
  offsetX: number
  offsetZ: number
  /** This stem's own radius. */
  radius: number
}

/**
 * Radius of the fused outline in one direction, relative to the nominal radius.
 *
 * `blend` is the fold softness. Zero leaves the sharp crease two touching
 * cylinders really have; a small positive value rounds it just enough that the
 * smooth-normal pass does not produce a black line down every fold.
 */
export function fusedStemRadius(
  lobes: readonly FusedStemLobe[],
  cosine: number,
  sine: number,
  blend: number,
): number {
  let outline = 0
  for (const lobe of lobes) {
    const along = lobe.offsetX * cosine + lobe.offsetZ * sine
    const across = lobe.offsetX * sine - lobe.offsetZ * cosine
    const discriminant = lobe.radius * lobe.radius - across * across
    // A stem the ray misses entirely contributes nothing in this direction.
    if (discriminant <= 0) continue
    const reach = along + Math.sqrt(discriminant)
    if (reach <= 0) continue
    if (outline === 0) {
      outline = reach
      continue
    }
    // Soft maximum. A hard max is the true union and leaves a crease at every
    // fold; this keeps the fold but gives it a finite radius.
    const separation = Math.abs(reach - outline)
    outline = Math.max(reach, outline) +
      (blend > 1e-6 && separation < blend
        ? (blend - separation) * (blend - separation) * 0.25 / blend
        : 0)
  }
  return outline
}

/**
 * Builds a ring of fused stems around a shared centre.
 *
 * `spread` is how far the stem centres sit from the axis and `unevenness` how
 * much their radii and angles differ. Every term is driven by the caller's
 * hash so a species reads as the same individual from every station and every
 * level of detail.
 */
export function fusedStemRing(
  count: number,
  spread: number,
  unevenness: number,
  phase: number,
  variation: (index: number) => number,
): FusedStemLobe[] {
  const lobes: FusedStemLobe[] = []
  const clamped = Math.max(1, Math.round(count))
  for (let index = 0; index < clamped; index += 1) {
    const jitter = variation(index)
    const angle = phase + (index / clamped) * Math.PI * 2 +
      (jitter - 0.5) * unevenness * 1.5
    const offset = spread * (1 + (variation(index + 97) - 0.5) * unevenness * 1.4)
    // Each stem reaches the nominal outline on its own far side, so the fused
    // envelope stays inside the authored radius no matter how uneven it gets.
    //
    // The lower bound is structural, not cosmetic. A stem whose radius is less
    // than its own offset does not contain the member axis, so a ray from that
    // axis can miss it entirely — and the outline then *jumps* at the azimuth
    // where that stem drops out of the union. Swept up a member whose spread
    // changes with height, that jump sweeps into a hard circumferential ring
    // across the bole. Keeping every stem over its own axis guarantees the
    // outline stays a single-valued, continuous function of azimuth.
    const radius = Math.max(
      offset * 1.06,
      Math.max(0.12, 1 - offset) *
        (1 + (variation(index + 211) - 0.5) * unevenness),
    )
    lobes.push({
      offsetX: Math.cos(angle) * offset,
      offsetZ: Math.sin(angle) * offset,
      radius,
    })
  }
  return lobes
}

/** Interpolates two fused outlines station to station along a member. */
export function interpolateFusedStems(
  a: readonly FusedStemLobe[] | undefined,
  b: readonly FusedStemLobe[] | undefined,
  amount: number,
): readonly FusedStemLobe[] | undefined {
  if (!a && !b) return undefined
  if (!a) return b
  if (!b) return a
  const count = Math.min(a.length, b.length)
  const lobes: FusedStemLobe[] = []
  for (let index = 0; index < count; index += 1) {
    const left = a[index]!
    const right = b[index]!
    lobes.push({
      offsetX: left.offsetX + (right.offsetX - left.offsetX) * amount,
      offsetZ: left.offsetZ + (right.offsetZ - left.offsetZ) * amount,
      radius: left.radius + (right.radius - left.radius) * amount,
    })
  }
  return lobes
}

/** Angular sampling a fused outline needs before its folds start faceting. */
export function fusedStemSegments(lobes: readonly FusedStemLobe[]): number {
  // A fold is narrow relative to the stem that forms it, so the sampling has to
  // resolve the valley, not the stem. At nine sides per stem a bole several
  // metres across spent two segments crossing each fold and the whole plan
  // smoothed back into a cylinder.
  return Math.max(16, lobes.length * 14)
}
