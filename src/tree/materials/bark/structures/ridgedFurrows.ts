import { tiledValueNoiseGradient } from '../../proceduralNoise'

/**
 * A tiling network of narrow branching creases: 1 in the bottom of a furrow,
 * 0 on open bark.
 *
 * Cell networks are the wrong primitive for a furrowed bark. Every cell has
 * exactly one closed boundary, so every furrow they produce runs unbroken
 * around a plate and the trunk comes out looking quilted. A furrow in real
 * cork is a tear: it starts somewhere, forks, runs for a while at varying
 * width and then simply stops, because it is the record of the stem outgrowing
 * a dead outer layer rather than the edge of a tile.
 *
 * The zero set of a noise field has exactly that topology for free. The
 * difficulty is drawing it at a controlled width. Folding the noise about its
 * midpoint — the usual ridged-multifractal trick — gives a band whose width is
 * inversely proportional to the local gradient, and a value-noise gradient
 * varies by more than an order of magnitude across a tile. What comes out is
 * not a network of cracks at all but a field of puddles: wherever the noise
 * happens to be flat, the "crease" swells into a blob tens of texels across.
 * Lit, those are the soft dark continents that make a procedural trunk look
 * water-stained rather than fissured, and no amount of thresholding fixes it,
 * because the threshold cannot distinguish a wide crease from a deep one.
 *
 * Dividing the fold by the gradient magnitude turns it into a first-order
 * estimate of the distance to the zero set, and a distance can be thresholded
 * at a width that means the same thing everywhere on the tile. The gradient
 * comes from the bilinear form directly rather than from finite differences,
 * which is the same number at a quarter of the hashing.
 */
const SAMPLE = new Float64Array(3)

export function ridgedFurrow(
  u: number,
  v: number,
  cyclesU: number,
  cyclesV: number,
  seed: number,
  octaves = 4,
  /**
   * Crease width in cell units at the coarsest octave. Narrower is sharper;
   * each finer octave draws proportionally finer cracks.
   */
  width = 0.18,
): number {
  let spanX = Math.max(1, Math.round(cyclesU))
  let spanY = Math.max(1, Math.round(cyclesV))
  let amplitude = 1
  let strongest = 0
  for (let octave = 0; octave < octaves; octave += 1) {
    const key = seed + octave * 131
    tiledValueNoiseGradient(u * spanX, v * spanY, key, spanX, spanY, SAMPLE)
    const centre = SAMPLE[0]! * 2 - 1
    const gx = SAMPLE[1]! * 2
    const gy = SAMPLE[2]! * 2
    const gradient = Math.sqrt(gx * gx + gy * gy)
    // The distance, in cell units, from here to the crease this octave draws.
    const distance = Math.abs(centre) / Math.max(1e-3, gradient)
    const half = width * 0.5
    const line = distance >= half ? 0 : 1 - smooth(distance / half)
    // The union of the tiers rather than their sum. Cracks at different scales
    // do not add their depths where they cross — one runs into the other — and
    // summing them puts a conspicuous dark knot at every junction.
    strongest = Math.max(strongest, line * amplitude)
    spanX = Math.max(1, Math.round(spanX * 2))
    spanY = Math.max(1, Math.round(spanY * 2))
    // Finer cracks are shallower, which is the hierarchy that makes a surface
    // read as fissured at one distance and merely rough at another.
    amplitude *= 0.62
  }
  return strongest
}

function smooth(value: number): number {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped * clamped * (3 - 2 * clamped)
}
