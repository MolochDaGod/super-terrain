import { byte, clamp01, positiveModulo } from '../proceduralNoise'

/**
 * Directions and radii the horizon is swept along.
 *
 * The horizon has to be sampled out past the width of the widest trough, or a
 * wide fissure comes back unoccluded: every neighbour inside the search radius
 * is down in the fissure too, so nothing rises above the sample point and the
 * floor reads as open sky. The visible result is a fissure showing only as a
 * thin dark line along its deepest crack instead of as a shadowed trough with
 * two lit walls — most of the difference between bark and lines on a cylinder.
 */
const DIRECTIONS = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
] as const
const RADII = [2, 4, 9, 18, 32] as const

/**
 * Packs local, multi-scale self-occlusion into the red channel of an ORM map.
 * AO is applied only to indirect light by the material; it remains absent from
 * albedo so a sun-facing fissure can still be lit.
 *
 * Solved at half resolution and bilinearly resampled. Occlusion is a
 * low-frequency quantity — it is an integral over a neighbourhood tens of
 * texels wide — so full-resolution sampling buys nothing visible while costing
 * four times the work, and at forty samples a texel over a two-megapixel map
 * that had become the single most expensive step in the whole tree bake.
 */
export function packBarkAmbientOcclusion(
  heights: Float32Array,
  furrows: Float32Array,
  target: Uint8Array,
  width: number,
  height: number,
  /**
   * Contact shadow under an overlapping scale lip. The horizon sweep cannot
   * find it: it runs at half resolution over radii of two texels and up, and a
   * scale lip is a step one texel wide, so the one piece of occlusion that
   * sits on a hard edge has to be supplied directly.
   */
  lips?: Float32Array,
): void {
  const half = width >= 64 && height >= 64
  const scale = half ? 2 : 1
  const lowWidth = Math.max(1, Math.floor(width / scale))
  const lowHeight = Math.max(1, Math.floor(height / scale))
  const lowHeights = half ? downsample(heights, width, height, lowWidth, lowHeight) : heights
  const occlusion = new Float32Array(lowWidth * lowHeight)
  const sampleXs = new Int32Array(DIRECTIONS.length * RADII.length * lowWidth)
  const sampleYs = new Int32Array(DIRECTIONS.length * RADII.length * lowHeight)
  for (let direction = 0; direction < DIRECTIONS.length; direction += 1) {
    const [dx, dy] = DIRECTIONS[direction]!
    for (let step = 0; step < RADII.length; step += 1) {
      const radius = RADII[step]!
      const slot = direction * RADII.length + step
      const xOffset = slot * lowWidth
      const yOffset = slot * lowHeight
      for (let x = 0; x < lowWidth; x += 1) {
        sampleXs[xOffset + x] = positiveModulo(x + dx * radius, lowWidth)
      }
      for (let y = 0; y < lowHeight; y += 1) {
        sampleYs[yOffset + y] = positiveModulo(y + dy * radius, lowHeight)
      }
    }
  }

  for (let y = 0; y < lowHeight; y += 1) {
    for (let x = 0; x < lowWidth; x += 1) {
      const index = y * lowWidth + x
      const centre = lowHeights[index]!
      let shelter = 0
      for (let direction = 0; direction < DIRECTIONS.length; direction += 1) {
        let horizon = 0
        for (let step = 0; step < RADII.length; step += 1) {
          const radius = RADII[step]!
          // A single `+ width` before the modulo only lands back in range while
          // the radius is smaller than the map. Once it is not, the index goes
          // negative, the lookup yields undefined, and everything downstream
          // becomes NaN — which packs as a black texel rather than failing.
          const slot = direction * RADII.length + step
          const sampleX = sampleXs[slot * lowWidth + x]!
          const sampleY = sampleYs[slot * lowHeight + y]!
          // The bias grows with distance so a gently domed plate does not
          // shadow itself; without it, broad relief reads as grime.
          const rise = lowHeights[sampleY * lowWidth + sampleX]! - centre -
            radius * 0.0044
          horizon = Math.max(horizon, rise)
        }
        shelter += horizon
      }
      occlusion[index] = shelter / DIRECTIONS.length
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      let shelter: number
      if (half) {
        const left = x >> 1
        const top = y >> 1
        const right = left + 1 === lowWidth ? 0 : left + 1
        const bottom = top + 1 === lowHeight ? 0 : top + 1
        const fractionX = (x & 1) * 0.5
        const fractionY = (y & 1) * 0.5
        const upper = occlusion[top * lowWidth + left]! * (1 - fractionX) +
          occlusion[top * lowWidth + right]! * fractionX
        const lower = occlusion[bottom * lowWidth + left]! * (1 - fractionX) +
          occlusion[bottom * lowWidth + right]! * fractionX
        shelter = upper * (1 - fractionY) + lower * fractionY
      } else {
        shelter = occlusion[index]!
      }
      // The fissure term stays at full resolution: it is the one part of the
      // occlusion that follows a sharp edge, and resampling it would soften
      // every crack rim by a texel.
      const fissure = Math.pow(furrows[index]!, 0.78)
      const lip = lips ? lips[index]! : 0
      target[index * 4] = byte(clamp01(1 - fissure * 0.14 - shelter * 0.5 - lip * 0.3))
    }
  }
}

function downsample(
  source: Float32Array,
  width: number,
  height: number,
  lowWidth: number,
  lowHeight: number,
): Float32Array {
  const result = new Float32Array(lowWidth * lowHeight)
  for (let y = 0; y < lowHeight; y += 1) {
    const top = Math.min(height - 1, y * 2)
    const bottom = Math.min(height - 1, y * 2 + 1)
    for (let x = 0; x < lowWidth; x += 1) {
      const left = Math.min(width - 1, x * 2)
      const right = Math.min(width - 1, x * 2 + 1)
      result[y * lowWidth + x] = (
        source[top * width + left]! + source[top * width + right]! +
        source[bottom * width + left]! + source[bottom * width + right]!
      ) / 4
    }
  }
  return result
}
