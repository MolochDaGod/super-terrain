import { hash2, positiveModulo, smooth01 } from '../../proceduralNoise'

/** What a scar does to the surface at one texel. */
export interface ScarSample {
  /** 1 on healed scar tissue, 0 on ordinary bark. */
  tissue: number
  /** Signed relief: positive on the raised collar, negative in the hollow. */
  relief: number
}

/**
 * Healed branch scars and old wounds.
 *
 * A trunk with a perfectly regular fissure network over its whole height reads
 * as extruded stock, because nothing has ever happened to it. Real bark carries
 * its history: every limb the tree has shed leaves a healed socket, each with a
 * raised collar of wound wood around a smoother, paler, lichen-free centre, and
 * those few large features do more for close-range believability than any
 * amount of extra crack detail. They also break the vertical grain, which is
 * what stops a fissured bole reading as brushed timber.
 *
 * Scars are deliberately sparse and large. Scattering many small ones gives
 * pockmarking, which reads as damage to the texture rather than to the tree.
 */
export function sampleScars(
  u: number,
  v: number,
  /** Scar sites per tile width. Two or three is plenty on a 1.6-metre tile. */
  frequency: number,
  /** Vertical sites, normally scaled from the tile aspect. */
  rows: number,
  seed: number,
  /** Fraction of candidate sites that actually carry a scar. */
  incidence: number,
): ScarSample {
  if (incidence <= 0) return { tissue: 0, relief: 0 }
  const columns = Math.max(1, Math.round(frequency))
  const lines = Math.max(1, Math.round(rows))
  const x = u * columns
  const y = v * lines
  let tissue = 0
  let relief = 0

  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    const sourceY = Math.floor(y) + offsetY
    const wrappedY = positiveModulo(sourceY, lines)
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const sourceX = Math.floor(x) + offsetX
      const wrappedX = positiveModulo(sourceX, columns)
      // Most sites are empty. Gating here rather than by thresholding a noise
      // field keeps each surviving scar whole instead of eroding its rim.
      if (hash2(wrappedX, wrappedY, seed + 617) > incidence) continue
      const centreX = sourceX + 0.2 + hash2(wrappedX, wrappedY, seed + 631) * 0.6
      const centreY = sourceY + 0.2 + hash2(wrappedX, wrappedY, seed + 647) * 0.6
      // Sockets are broader than they are tall on a vertical bole, and no two
      // are the same size.
      const width = 0.2 + hash2(wrappedX, wrappedY, seed + 653) * 0.22
      const height = width * (0.62 + hash2(wrappedX, wrappedY, seed + 659) * 0.5)
      const dx = (x - centreX) / width
      const dy = (y - centreY) / height
      // A little irregularity, so the outline is not a drawn ellipse.
      const wobble = 1 + (hash2(
        Math.round(dx * 6) + wrappedX * 31, Math.round(dy * 6) + wrappedY * 17, seed + 661,
      ) - 0.5) * 0.34
      const distance = Math.hypot(dx, dy) * wobble
      if (distance > 1.45) continue
      // The healed face: everything inside the collar.
      const face = smooth01((0.86 - distance) / 0.3)
      // The collar: a ring of wound wood standing proud of the surrounding bark.
      const collar = Math.exp(-(((distance - 1.02) / 0.19) ** 2))
      tissue = Math.max(tissue, face)
      relief += collar * 0.55 - face * 0.4
    }
  }
  return { tissue: Math.min(1, tissue), relief }
}
