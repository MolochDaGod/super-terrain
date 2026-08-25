import { tiledFbm } from './proceduralNoise'

/**
 * A tiling fbm evaluated on a coarse lattice and bilinearly resampled.
 *
 * A two-megapixel bark map evaluates a dozen or more noise fields per texel,
 * and most of them are broad weathering and moisture washes running at two to
 * ten cycles across the whole tile. Evaluating those per texel is pure waste:
 * a field with a wavelength of two hundred texels is fully described by samples
 * every eight, and the interpolation error is far below a byte. Moving the
 * low-frequency half of the bake onto a coarse lattice is most of the
 * difference between a bake that blocks its worker for fifteen seconds and one
 * that does not, and it changes nothing anyone can see.
 *
 * Only use it for fields whose wavelength is comfortably longer than the
 * divisor — high-frequency grain sampled this way turns into visible blur.
 */
export class CoarseField {
  private readonly values: Float32Array
  private readonly lowWidth: number
  private readonly lowHeight: number
  private readonly scaleX: number
  private readonly scaleY: number
  private readonly x0: Int32Array
  private readonly x1: Int32Array
  private readonly fractionX: Float64Array
  private readonly y0Offset: Int32Array
  private readonly y1Offset: Int32Array
  private readonly fractionY: Float64Array

  /** Precomputes any tiling scalar field on a lattice `divisor` times coarser. */
  constructor(
    width: number,
    height: number,
    divisor: number,
    sample: (u: number, v: number) => number,
  ) {
    this.lowWidth = Math.max(4, Math.round(width / divisor))
    this.lowHeight = Math.max(4, Math.round(height / divisor))
    this.scaleX = this.lowWidth / width
    this.scaleY = this.lowHeight / height
    this.x0 = new Int32Array(width)
    this.x1 = new Int32Array(width)
    this.fractionX = new Float64Array(width)
    for (let x = 0; x < width; x += 1) {
      const sourceX = x * this.scaleX
      const left = Math.floor(sourceX)
      this.x0[x] = left
      this.x1[x] = left + 1 === this.lowWidth ? 0 : left + 1
      this.fractionX[x] = sourceX - left
    }
    this.y0Offset = new Int32Array(height)
    this.y1Offset = new Int32Array(height)
    this.fractionY = new Float64Array(height)
    for (let y = 0; y < height; y += 1) {
      const sourceY = y * this.scaleY
      const top = Math.floor(sourceY)
      this.y0Offset[y] = top * this.lowWidth
      this.y1Offset[y] = (top + 1 === this.lowHeight ? 0 : top + 1) * this.lowWidth
      this.fractionY[y] = sourceY - top
    }
    this.values = new Float32Array(this.lowWidth * this.lowHeight)
    for (let y = 0; y < this.lowHeight; y += 1) {
      const v = y / this.lowHeight
      for (let x = 0; x < this.lowWidth; x += 1) {
        this.values[y * this.lowWidth + x] = sample(x / this.lowWidth, v)
      }
    }
  }

  /** The common case: a tiling fbm at the given cycle counts. */
  static fbm(
    width: number,
    height: number,
    cyclesU: number,
    cyclesV: number,
    seed: number,
    octaves: number,
    divisor: number,
  ): CoarseField {
    return new CoarseField(width, height, divisor, (u, v) =>
      tiledFbm(u * cyclesU, v * cyclesV, seed, octaves, cyclesU, cyclesV))
  }

  /** Samples at a full-resolution texel. Wraps, preserving both tile seams. */
  at(x: number, y: number): number {
    const fractionX = this.fractionX[x]!
    const fractionY = this.fractionY[y]!
    const x0 = this.x0[x]!
    const x1 = this.x1[x]!
    const y0 = this.y0Offset[y]!
    const y1 = this.y1Offset[y]!
    const upper = this.values[y0 + x0]! * (1 - fractionX) +
      this.values[y0 + x1]! * fractionX
    const lower = this.values[y1 + x0]! * (1 - fractionX) +
      this.values[y1 + x1]! * fractionX
    return upper * (1 - fractionY) + lower * fractionY
  }
}
