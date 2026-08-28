import {
  ClampToEdgeWrapping,
  LinearFilter,
  RGBAFormat,
  StorageTexture,
  UnsignedByteType,
  Vector4,
  type Renderer,
} from 'three/webgpu'
import type ComputeNode from 'three/src/nodes/gpgpu/ComputeNode.js'
import { FOLIAGE_MASK_ROWS } from './foliageSpecies'
import {
  Fn,
  If,
  attributeArray,
  clamp,
  float,
  instanceIndex,
  int,
  ivec2,
  max,
  select,
  smoothstep,
  textureStore,
  uint,
  uniform,
  vec2,
  vec4,
} from 'three/tsl'

/** Cells across the painted field. 512 over 400 m gives a 0.78 m footprint. */
export const FOLIAGE_MASK_RESOLUTION = 512

/** Metres covered by the mask, centred on the world origin. */
export const FOLIAGE_FIELD_SIZE = 400

export type FoliagePaintMode = 'paint' | 'erase'

const createMaskBuffer = (cells: number) =>
  attributeArray(cells * FOLIAGE_MASK_ROWS, 'vec4')
export type FoliageMaskBuffer = ReturnType<typeof createMaskBuffer>

export interface FoliagePaintStroke {
  /** World-space xz of the previous sample, so a fast drag paints a capsule. */
  fromX: number
  fromZ: number
  toX: number
  toZ: number
  radius: number
  /** Weight added per dab, 0..1. */
  flow: number
  /** 0 is a fully feathered dab, 1 a hard-edged one. */
  hardness: number
  species: number
  mode: FoliagePaintMode
}

/**
 * The painted ground-cover field: which species grow where, and how thickly.
 *
 * Two representations of the same data are kept deliberately.
 *
 * The authoritative copy is a storage buffer, because painting is a
 * read-modify-write — a stroke adds to what is already there and lets the
 * other species recede — and WebGPU storage textures are write-only. The
 * population kernel reads that buffer directly.
 *
 * The mirror is a pair of RGBA8 storage textures written by the same kernel.
 * Those exist so the *ground* material can sample the field with hardware
 * filtering in a fragment shader, which is how the far-field canopy stays
 * smooth and how it agrees exactly with the blades standing on top of it.
 */
export class FoliageMaskField {
  readonly resolution = FOLIAGE_MASK_RESOLUTION
  readonly fieldSize = FOLIAGE_FIELD_SIZE

  /**
   * Species weights in groups of four, linear filtered, for the ground canopy.
   * One texture per mask row; the ground material sums them all.
   */
  readonly weights: readonly StorageTexture[]

  /** `FOLIAGE_MASK_ROWS` vec4 rows per cell, four species weights each. */
  readonly buffer: FoliageMaskBuffer

  private readonly strokeSegment = uniform(new Vector4())
  private readonly strokeShape = uniform(new Vector4())
  private readonly strokeSpecies = uniform(0)
  private readonly strokeSign = uniform(1)
  private readonly paintKernel: ComputeNode
  private disposed = false

  constructor() {
    const resolution = this.resolution
    const cells = resolution * resolution

    this.weights = Array.from({ length: FOLIAGE_MASK_ROWS }, (_, row) =>
      createWeightTexture(
        `foliage-mask-weights-${row * 4}-${row * 4 + 3}`,
        resolution,
      ),
    )
    this.buffer = createMaskBuffer(cells)

    const texel = float(this.fieldSize / resolution)
    const halfField = float(this.fieldSize * 0.5)
    const segment = this.strokeSegment
    const shape = this.strokeShape
    const species = this.strokeSpecies
    const sign = this.strokeSign
    const buffer = this.buffer
    const weights = this.weights

    this.paintKernel = Fn(() => {
      const cellX = instanceIndex.mod(uint(resolution)).toVar()
      const cellY = instanceIndex.div(uint(resolution)).toVar()
      const worldX = float(cellX).add(0.5).mul(texel).sub(halfField)
      const worldZ = float(cellY).add(0.5).mul(texel).sub(halfField)

      // Distance to the stroke *segment*, not to its end point. A pointer that
      // travels thirty pixels between two frames would otherwise leave a row of
      // disconnected dabs, which is the most obvious way a painting tool
      // announces that it is sampling rather than drawing.
      const a = vec2(segment.x, segment.y)
      const b = vec2(segment.z, segment.w)
      const p = vec2(worldX, worldZ)
      const ab = b.sub(a)
      const lengthSq = max(ab.dot(ab), float(1e-6))
      const t = clamp(p.sub(a).dot(ab).div(lengthSq), 0, 1)
      const distance = p.sub(a.add(ab.mul(t))).length()

      const radius = shape.x
      const inner = radius.mul(clamp(shape.z, 0, 0.98))
      const amount = smoothstep(radius, inner, distance).mul(shape.y)

      const base = instanceIndex.mul(uint(FOLIAGE_MASK_ROWS))
      const rows = Array.from({ length: FOLIAGE_MASK_ROWS }, (_, row) =>
        buffer.element(base.add(uint(row))).toVar(`foliageWeights${row}`),
      )

      If(amount.greaterThan(0.0002), () => {
        // Adding to one species while the others recede is what makes a second
        // pass with a different brush read as succession rather than as two
        // decals stacked on the same square metre. The recession is partial, so
        // the mixed band at the edge of a stroke survives and the population
        // kernel turns it into genuinely interleaved plants.
        const gain = amount.mul(max(sign, 0))
        const loss = amount.mul(max(sign.negate(), 0))
        const competition = clamp(gain.mul(0.55).add(loss).oneMinus(), 0, 1)
        const selected = int(species)
        const one = float(1)
        const zero = float(0)
        rows.forEach((current, row) => {
          const add = vec4(
            select(selected.equal(int(row * 4)), one, zero),
            select(selected.equal(int(row * 4 + 1)), one, zero),
            select(selected.equal(int(row * 4 + 2)), one, zero),
            select(selected.equal(int(row * 4 + 3)), one, zero),
          ).mul(gain)
          current.assign(clamp(current.mul(competition).add(add), 0, 1))
        })
      })

      const coord = ivec2(int(cellX), int(cellY))
      rows.forEach((current, row) => {
        buffer.element(base.add(uint(row))).assign(current)
        textureStore(weights[row]!, coord, current)
      })
    })().compute(cells)
  }

  /** Runs one stroke segment. One dispatch per frame while the pointer is down. */
  paint(renderer: Renderer, stroke: FoliagePaintStroke): void {
    if (this.disposed) return
    this.strokeSegment.value.set(stroke.fromX, stroke.fromZ, stroke.toX, stroke.toZ)
    this.strokeShape.value.set(
      Math.max(stroke.radius, 0.05),
      Math.min(Math.max(stroke.flow, 0), 1),
      Math.min(Math.max(stroke.hardness, 0), 0.98),
      0,
    )
    this.strokeSpecies.value = stroke.species
    this.strokeSign.value = stroke.mode === 'erase' ? -1 : 1
    renderer.compute(this.paintKernel)
  }

  /** Lays the given species over the whole field, or clears it when erasing. */
  fill(renderer: Renderer, species: number, mode: FoliagePaintMode): void {
    this.paint(renderer, {
      fromX: 0,
      fromZ: 0,
      toX: 0,
      toZ: 0,
      radius: this.fieldSize,
      flow: 1,
      hardness: 0.98,
      species,
      mode,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const texture of this.weights) texture.dispose()
  }
}

function createWeightTexture(name: string, resolution: number): StorageTexture {
  const texture = new StorageTexture(resolution, resolution)
  texture.name = name
  texture.format = RGBAFormat
  texture.type = UnsignedByteType
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.generateMipmaps = false
  // Auto mipmap regeneration after every compute write would cost a blit per
  // stroke for a field nothing samples with mips.
  ;(texture as StorageTexture & { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false
  return texture
}
