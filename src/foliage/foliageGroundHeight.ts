import { Vector2 } from 'three/webgpu'
import { attributeArray, clamp, floor, int, mix, uint, uniform } from 'three/tsl'

/** See the note in `FoliagePopulation` — these are node builders, not values. */
type ShaderValue = any

/**
 * Samples along one side of the height window.
 *
 * 257 rather than 256 so the window's far edge is a sample rather than half a
 * cell past the last one, which is what makes two adjacent windows agree where
 * they meet. Over a 1024-metre window that is a four-metre spacing: coarse for
 * a cliff and entirely adequate for grass, which only has to sit on the ground
 * to within less than its own height.
 */
export const FOLIAGE_GROUND_RESOLUTION = 257

const createHeightBuffer = (samples: number) => attributeArray(samples, 'float')

/**
 * The ground the ground cover stands on.
 *
 * The foliage system was written against a plane at y = 0 — the population
 * kernel wrote a literal zero into every instance's Y — which is correct for
 * the tree lab and puts every blade of grass in a terrain world either buried
 * in a hillside or hanging in the air above a valley.
 *
 * A height *buffer* rather than a texture, and read with a hand-written
 * bilinear filter, because the consumer that matters is a compute kernel:
 * filtered texture sampling in compute needs an explicit-LOD path that is
 * awkward to express and easy to get subtly wrong, while a storage buffer read
 * is the same operation the mask already does a dozen of in the same kernel.
 *
 * Nothing is read back and nothing is uploaded per frame. The window is filled
 * on the CPU when it moves, in slices, from the same `sampleHeight` the stem
 * layout uses — so a tuft of grass and the tree beside it are standing on
 * exactly the same number.
 */
export class FoliageGroundHeightField {
  readonly resolution = FOLIAGE_GROUND_RESOLUTION
  /** One float per sample, row-major from the window's minimum corner. */
  readonly heights = createHeightBuffer(
    FOLIAGE_GROUND_RESOLUTION * FOLIAGE_GROUND_RESOLUTION,
  )
  /** Window centre in world XZ. */
  readonly origin = uniform(new Vector2())
  /** Window edge in metres. */
  readonly size = uniform(1)
  /** 0 makes every sample read as zero, which is the flat-ground lab. */
  readonly enabled = uniform(0)

  private readonly reader: ShaderValue

  originX = 0
  originZ = 0
  sizeMetres = 1

  constructor() {
    // Read-only: WGSL will not bind a read_write storage buffer to a vertex
    // stage, and the blade material reads the same instance data the kernel
    // wrote. Declaring the access we actually use keeps one buffer serving
    // both.
    this.reader = (this.heights as ShaderValue).toReadOnly()
  }

  /**
   * Ground height at a world position, as a node.
   *
   * Clamped at the window edge rather than faded to zero: a blade one metre
   * outside the window belongs on the ground, and the nearest edge sample is a
   * far better guess at where that is than sea level.
   */
  sampleHeight(x: ShaderValue, z: ShaderValue): ShaderValue {
    const last = this.resolution - 1
    const u = x.sub(this.origin.x).div(this.size).add(0.5).mul(last)
    const v = z.sub(this.origin.y).div(this.size).add(0.5).mul(last)
    const cu = clamp(u, 0, last)
    const cv = clamp(v, 0, last)
    const x0 = floor(cu)
    const z0 = floor(cv)
    const tx = cu.sub(x0)
    const tz = cv.sub(z0)
    const x1 = clamp(x0.add(1), 0, last)
    const z1 = clamp(z0.add(1), 0, last)

    const at = (column: ShaderValue, row: ShaderValue): ShaderValue =>
      this.reader.element(uint(int(row).mul(int(this.resolution)).add(int(column))))

    const a = at(x0, z0)
    const b = at(x1, z0)
    const c = at(x0, z1)
    const d = at(x1, z1)
    return mix(mix(a, b, tx), mix(c, d, tx), tz).mul(this.enabled)
  }

  /**
   * Refills the window from a height function.
   *
   * Synchronous and complete: 66k height samples through the terrain's cached
   * sampler is a few milliseconds, it happens only when the window moves by a
   * significant fraction of its own size, and slicing it across frames would
   * mean a window that is half old ground for as long as the slicing takes —
   * which is visible as a seam of floating grass running across the view.
   */
  update(
    originX: number,
    originZ: number,
    sizeMetres: number,
    sampleHeight: (x: number, z: number) => number,
  ): void {
    this.originX = originX
    this.originZ = originZ
    this.sizeMetres = sizeMetres
    this.origin.value.set(originX, originZ)
    this.size.value = sizeMetres
    this.enabled.value = 1

    const attribute = (this.heights as ShaderValue).value as {
      array: Float32Array
      needsUpdate: boolean
    }
    const last = this.resolution - 1
    const step = sizeMetres / last
    const minX = originX - sizeMetres * 0.5
    const minZ = originZ - sizeMetres * 0.5
    for (let row = 0; row <= last; row += 1) {
      const z = minZ + row * step
      const offset = row * this.resolution
      for (let column = 0; column <= last; column += 1) {
        attribute.array[offset + column] = sampleHeight(minX + column * step, z)
      }
    }
    attribute.needsUpdate = true
  }

  /** Puts every sample back to zero: the lab's flat ground. */
  disable(): void {
    this.enabled.value = 0
  }
}

/** A field that always reads zero, for workspaces whose ground is a plane. */
export function flatGroundHeight(): FoliageGroundHeightField {
  const field = new FoliageGroundHeightField()
  field.disable()
  return field
}
