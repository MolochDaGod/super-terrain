/** Vein intensities at one point in blade space, each 0..1. */
export interface Venation {
  /** The central rib: raised, opaque, and pale on the upper surface. */
  midrib: number
  /** Secondaries running from the midrib out to each lobe apex. */
  lateral: number
  /** The fine intercostal mesh. Reads as texture, never as line work. */
  reticulate: number
}

/**
 * The outline and venation of one blade, resolved once per leaf.
 *
 * Resolving it per leaf rather than per texel is what keeps the outline and the
 * venation talking about the same structure — it is why the secondaries land on
 * the lobe apices instead of drifting across them.
 */
export interface BladeShape {
  /** Half-width in blade-length units at u along the blade. */
  halfWidth(u: number, side: number): number
  /** Vein field at a point in blade space; v is in blade-length units. */
  veins(u: number, v: number, side: number): Venation
  /** Longest half-width either side reaches, for bounding the rasteriser. */
  readonly reach: number
  /** Petiole half-width in blade-length units. */
  readonly stalkHalfWidth: number
}

/** A rib and nothing else: the venation of any narrow strap-shaped blade. */
export function ribOnly(width: number): (u: number, v: number) => Venation {
  return (_u, v) => ({
    midrib: Math.exp(-((v / width) ** 2)),
    lateral: 0,
    reticulate: 0,
  })
}
