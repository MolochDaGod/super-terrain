import { Vector2 } from 'three/webgpu'
import { attributeArray, clamp, floor, int, mix, step, uint, uniform } from 'three/tsl'

/** See the note in `FoliagePopulation` — these are node builders, not values. */
type ShaderValue = any

/** Samples along one side. 256² over a field is a metre or two per cell. */
export const FOLIAGE_RASTER_RESOLUTION = 256

/**
 * An arbitrary scalar field over a rectangle of world, readable from a shader.
 *
 * The forest fields are shapes somebody dragged, and every part of the ground
 * cover needs to know how much forest is at a point: which layers the floor is
 * painted with, how densely, and how far the litter reaches past the last stem.
 * Uploading that shape once and sampling it is the alternative to stamping a
 * thousand overlapping brush dabs to approximate it, which is what a first
 * attempt at this does and what makes it take two seconds and still look like
 * a stack of circles.
 *
 * Zero outside the rectangle, deliberately and unlike
 * `FoliageGroundHeightField`, which clamps: ground continues past the edge of
 * its window and a forest does not.
 */
export class FoliageWorldRaster {
  readonly resolution = FOLIAGE_RASTER_RESOLUTION
  readonly values = attributeArray(
    FOLIAGE_RASTER_RESOLUTION * FOLIAGE_RASTER_RESOLUTION,
    'float',
  )
  /** Rectangle centre in world XZ. */
  readonly origin = uniform(new Vector2())
  /** Rectangle extent in metres. */
  readonly extent = uniform(new Vector2(1, 1))

  private readonly reader: ShaderValue = (this.values as ShaderValue).toReadOnly()

  sample(x: ShaderValue, z: ShaderValue): ShaderValue {
    const last = this.resolution - 1
    const u = x.sub(this.origin.x).div(this.extent.x).add(0.5)
    const v = z.sub(this.origin.y).div(this.extent.y).add(0.5)
    const inside = step(0, u).mul(step(u, 1)).mul(step(0, v)).mul(step(v, 1))
    const cu = clamp(u.mul(last), 0, last)
    const cv = clamp(v.mul(last), 0, last)
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
    return mix(mix(a, b, tx), mix(c, d, tx), tz).mul(inside)
  }

  /** Resamples a world rectangle through `value`. */
  update(
    centreX: number,
    centreZ: number,
    width: number,
    depth: number,
    value: (x: number, z: number) => number,
  ): void {
    this.origin.value.set(centreX, centreZ)
    this.extent.value.set(Math.max(width, 1e-3), Math.max(depth, 1e-3))
    const attribute = (this.values as ShaderValue).value as {
      array: Float32Array
      needsUpdate: boolean
    }
    const last = this.resolution - 1
    const stepX = width / last
    const stepZ = depth / last
    const minX = centreX - width * 0.5
    const minZ = centreZ - depth * 0.5
    for (let row = 0; row <= last; row += 1) {
      const z = minZ + row * stepZ
      const offset = row * this.resolution
      for (let column = 0; column <= last; column += 1) {
        attribute.array[offset + column] = value(minX + column * stepX, z)
      }
    }
    attribute.needsUpdate = true
  }
}
