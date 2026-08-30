import {
  ClampToEdgeWrapping,
  LinearFilter,
  RGBAFormat,
  StorageTexture,
  UnsignedByteType,
  Vector2,
  Vector4,
  type Renderer,
} from 'three/webgpu'
import type ComputeNode from 'three/src/nodes/gpgpu/ComputeNode.js'
import {
  AGGREGATE_COLOURS,
  FOLIAGE_MASK_ROWS,
  SWARD_COLOUR_SCALE,
} from './foliageSpecies'
import { FOLIAGE_SURFACE_ROWS } from './foliageSurfaces'
import { fbm2 } from './foliageNoise'
import { FoliageWorldRaster } from './foliageWorldRaster'
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
  vec3,
  vec4,
} from 'three/tsl'

/** See the note in `FoliagePopulation` — these are node builders, not values. */
type ShaderValue = any

/** Cells across the painted field. 512 over 400 m gives a 0.78 m footprint. */
export const FOLIAGE_MASK_RESOLUTION = 512

/** Metres covered by the mask. Its centre is `FoliageMaskField.origin`. */
export const FOLIAGE_FIELD_SIZE = 400

export type FoliagePaintMode = 'paint' | 'erase'

/**
 * Which of the two fields a stroke writes.
 *
 * `plants` is the species mask the population kernel draws clumps from;
 * `surface` is the ground layer the material shades the floor with. They are
 * painted by the same kernel with the same falloff and the same competition,
 * because they are the same kind of thing — a weight per cell that other
 * weights in the same set recede against.
 *
 * Erasing ignores this and thins both. A viewer dragging the eraser over a
 * patch of floor means "take this away", and leaving the leaf litter behind
 * because a grass was selected in the palette is the behaviour that made the
 * seeded floor feel like it was welded on.
 */
export type FoliagePaintLayer = 'plants' | 'surface'

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
  /** Index within `layer`: a species number, or a surface channel. */
  species: number
  /** Which field the stroke writes. Ignored while erasing, which thins both. */
  layer?: FoliagePaintLayer
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
  readonly fieldSize: number

  /**
   * Where the field is, in the world.
   *
   * It used to be nailed to the world origin, which is fine for a lab whose
   * whole ground is four hundred metres across and useless for a four-kilometre
   * terrain: a forest drawn on a ridge a kilometre out would have had no ground
   * cover at all, because every cell of the mask was somewhere else.
   *
   * Moving it is cheap precisely because nothing in the mask is authored by
   * hand on terrain — the forest splines are the record, and the mask is a
   * cache rasterised from them. Recentring is therefore: clear, repaint the
   * fields that overlap the new window, and carry on.
   */
  readonly origin = uniform(new Vector2())

  /** Mirror of `origin` for the CPU side, which needs it to place fills. */
  originX = 0
  originZ = 0

  /**
   * Species weights in groups of four, linear filtered, for the ground canopy.
   * One texture per mask row; the ground material sums them all.
   */
  readonly weights: readonly StorageTexture[]

  /** `FOLIAGE_MASK_ROWS` vec4 rows per cell, four species weights each. */
  readonly buffer: FoliageMaskBuffer

  /**
   * Ground layer coverage, filtered, for the ground material.
   *
   * See `foliageSurfaces` for the channel order. Only the material reads it —
   * the population kernel has no use for what the floor is made of — so unlike
   * the species mask this one needs no storage-buffer mirror for the compute
   * side, just the buffer the paint kernel does its read-modify-write in.
   */
  readonly surfaces: readonly StorageTexture[]

  /** `FOLIAGE_SURFACE_ROWS` vec4 rows per cell. */
  readonly surfaceBuffer: FoliageMaskBuffer

  /**
   * The plants, summarised: rgb is their aggregate colour, a is their total.
   *
   * A convenience for the tree lab and a necessity for the terrain, which is
   * where it came from. The ground canopy resolves the sward by sampling every
   * weight row and computing a weighted mean per pixel; the terrain material
   * cannot afford to, because it already samples fourteen textures of its own
   * and the fragment stage's guaranteed budget is sixteen. Three more took it
   * to eighteen and the pipeline simply failed to create — no frame, no
   * warning in the app, only a validation error in the console.
   *
   * Doing the average once, in the kernel that already has every weight in
   * registers, costs one texture write per painted cell and turns three
   * dependent texture reads per pixel into one. That is the better arrangement
   * on its own terms; the texture limit is just what forced the question.
   */
  readonly sward: StorageTexture

  private readonly strokeSegment = uniform(new Vector4())
  private readonly strokeShape = uniform(new Vector4())
  private readonly strokeSpecies = uniform(0)
  private readonly strokeSign = uniform(1)
  /** 1 while the stroke is writing the ground layers rather than the plants. */
  private readonly strokeSurface = uniform(0)
  private readonly paintKernel: ComputeNode

  /**
   * Painting a shape rather than a stroke.
   *
   * A forest drawn on terrain is a region, and the floor inside it wants a
   * whole recipe laid down across it — four ground layers and half a dozen
   * plants. As brush dabs that is on the order of a thousand dispatches over
   * the whole 512² mask, and the result still looks like a thousand circles.
   * As one dispatch per channel, reading the region's own coverage raster, it
   * is ten dispatches with the shape's real edge, feather included.
   */
  readonly region = new FoliageWorldRaster()
  private readonly regionChannel = uniform(0)
  /** x weight, y noise scale in metres, z noise amount, w surface flag. */
  private readonly regionShape = uniform(new Vector4())
  private readonly regionKernel: ComputeNode
  private disposed = false

  constructor(fieldSize: number = FOLIAGE_FIELD_SIZE) {
    this.fieldSize = fieldSize
    const resolution = this.resolution
    const cells = resolution * resolution

    this.weights = Array.from({ length: FOLIAGE_MASK_ROWS }, (_, row) =>
      createWeightTexture(
        `foliage-mask-weights-${row * 4}-${row * 4 + 3}`,
        resolution,
      ),
    )
    this.buffer = createMaskBuffer(cells)
    this.surfaces = Array.from({ length: FOLIAGE_SURFACE_ROWS }, (_, row) =>
      createWeightTexture(`foliage-mask-surfaces-${row}`, resolution),
    )
    this.surfaceBuffer = attributeArray(cells * FOLIAGE_SURFACE_ROWS, 'vec4')
    this.sward = createWeightTexture('foliage-mask-sward', resolution)

    const texel = float(this.fieldSize / resolution)
    const halfField = float(this.fieldSize * 0.5)
    const origin = this.origin
    const segment = this.strokeSegment
    const shape = this.strokeShape
    const species = this.strokeSpecies
    const sign = this.strokeSign
    const surfaceStroke = this.strokeSurface
    const buffer = this.buffer
    const weights = this.weights
    const surfaceBuffer = this.surfaceBuffer
    const surfaces = this.surfaces
    const sward = this.sward

    /**
     * Packs the weighted mean plant colour and the total into one texel.
     *
     * Called at the end of both kernels, because both rewrite the weights and
     * a summary that only one of them maintained would be stale exactly when
     * the other had just been used.
     */
    const storeSward = (coord: ShaderValue, rows: ShaderValue[]): void => {
      let total: ShaderValue | null = null
      let blended: ShaderValue = vec3(0, 0, 0)
      AGGREGATE_COLOURS.forEach((aggregate, index) => {
        const row = rows[Math.floor(index / 4)]
        if (!row) return
        const weight = row[['x', 'y', 'z', 'w'][index % 4]!]
        total = total === null ? weight : total.add(weight)
        blended = blended.add(
          vec3(aggregate[0], aggregate[1], aggregate[2]).mul(weight),
        )
      })
      const sum = total ?? float(0)
      const mean: ShaderValue = blended
        .div(max(sum, float(1e-4)))
        .mul(SWARD_COLOUR_SCALE)
      textureStore(
        sward,
        coord,
        vec4(mean.clamp(0, 1), (sum as ShaderValue).clamp(0, 1)),
      )
    }

    this.paintKernel = Fn(() => {
      const cellX = instanceIndex.mod(uint(resolution)).toVar()
      const cellY = instanceIndex.div(uint(resolution)).toVar()
      const worldX = float(cellX).add(0.5).mul(texel).sub(halfField).add(origin.x)
      const worldZ = float(cellY).add(0.5).mul(texel).sub(halfField).add(origin.y)

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
      const surfaceBase = instanceIndex.mul(uint(FOLIAGE_SURFACE_ROWS))
      const surfaceRows = Array.from({ length: FOLIAGE_SURFACE_ROWS }, (_, row) =>
        surfaceBuffer.element(surfaceBase.add(uint(row))).toVar(`foliageSurface${row}`),
      )

      If(amount.greaterThan(0.0002), () => {
        // Adding to one species while the others recede is what makes a second
        // pass with a different brush read as succession rather than as two
        // decals stacked on the same square metre. The recession is partial, so
        // the mixed band at the edge of a stroke survives and the population
        // kernel turns it into genuinely interleaved plants.
        const gain = amount.mul(max(sign, 0))
        // Erasing thins both fields; painting only touches the one the brush
        // is aimed at. `surfaceStroke` is a uniform, so both halves of this
        // are a multiply by a constant for the whole dispatch rather than a
        // divergent branch.
        const loss = amount.mul(max(sign.negate(), 0))
        const plantGain = gain.mul(surfaceStroke.oneMinus())
        const surfaceGain = gain.mul(surfaceStroke)
        // A third, not half.
        //
        // At 0.55 a stroke took more than half of whatever was already growing
        // where it landed, and a seeded floor is a couple of hundred strokes:
        // the tall layers went in last and were then erased by the ones after
        // them, so a recipe that asked for ferns, bracken and bramble over a
        // moss base produced a moss base and almost nothing else. Measured
        // over the whole field, fern ended at 0.03 average weight against the
        // 0.5 its own dabs laid down.
        //
        // Plants interleave. A fern colony spreading through a moss mat does
        // not clear the moss, and two strokes that overlap should end up as a
        // mixture rather than as whichever went last.
        const plantCompetition = clamp(
          plantGain.mul(0.32).add(loss).oneMinus(), 0, 1,
        )
        // Ground layers displace each other far more completely than plants
        // do: a drift of leaves lying over moss hides it, where a fern growing
        // through a sward does not hide the sward.
        const surfaceCompetition = clamp(
          surfaceGain.mul(0.9).add(loss).oneMinus(), 0, 1,
        )
        const selected = int(species)
        const one = float(1)
        const zero = float(0)
        const channelMask = (row: number, weight: ShaderValue): ShaderValue => vec4(
          select(selected.equal(int(row * 4)), one, zero),
          select(selected.equal(int(row * 4 + 1)), one, zero),
          select(selected.equal(int(row * 4 + 2)), one, zero),
          select(selected.equal(int(row * 4 + 3)), one, zero),
        ).mul(weight)
        rows.forEach((current, row) => {
          current.assign(
            clamp(current.mul(plantCompetition).add(channelMask(row, plantGain)), 0, 1),
          )
        })
        surfaceRows.forEach((current, row) => {
          current.assign(
            clamp(
              current.mul(surfaceCompetition).add(channelMask(row, surfaceGain)),
              0,
              1,
            ),
          )
        })
      })

      const coord = ivec2(int(cellX), int(cellY))
      rows.forEach((current, row) => {
        buffer.element(base.add(uint(row))).assign(current)
        textureStore(weights[row]!, coord, current)
      })
      surfaceRows.forEach((current, row) => {
        surfaceBuffer.element(surfaceBase.add(uint(row))).assign(current)
        textureStore(surfaces[row]!, coord, current)
      })
      storeSward(coord, rows)
    })().compute(cells)

    const region = this.region
    const regionChannel = this.regionChannel
    const regionShape = this.regionShape

    this.regionKernel = Fn(() => {
      const cellX = instanceIndex.mod(uint(resolution)).toVar()
      const cellY = instanceIndex.div(uint(resolution)).toVar()
      const worldX = float(cellX).add(0.5).mul(texel).sub(halfField).add(origin.x)
      const worldZ = float(cellY).add(0.5).mul(texel).sub(halfField).add(origin.y)

      // The shape's own coverage, broken up by a noise field at the scale the
      // recipe asked for. Without the break-up every species in a stand would
      // have exactly the painted weight in every square metre of it, which is
      // the "lawn" failure the colony scatter existed to avoid — and the
      // population kernel's own patchiness cannot fix it, because that is a
      // per-species field and this would be a per-species *constant*.
      const coverage = region.sample(worldX, worldZ)
      const noiseScale = max(regionShape.y, float(1))
      const breakUp = fbm2(vec2(worldX, worldZ).div(noiseScale)
        .add(vec2(float(regionChannel).mul(37.1), float(regionChannel).mul(19.7))))
      const variation = float(1).sub(regionShape.z)
        .add(breakUp.mul(regionShape.z).mul(1.8))
      const amount = clamp(coverage.mul(regionShape.x).mul(variation), 0, 1)

      const base = instanceIndex.mul(uint(FOLIAGE_MASK_ROWS))
      const rows = Array.from({ length: FOLIAGE_MASK_ROWS }, (_, row) =>
        buffer.element(base.add(uint(row))).toVar(`regionWeights${row}`),
      )
      const surfaceBase = instanceIndex.mul(uint(FOLIAGE_SURFACE_ROWS))
      const surfaceRows = Array.from({ length: FOLIAGE_SURFACE_ROWS }, (_, row) =>
        surfaceBuffer.element(surfaceBase.add(uint(row))).toVar(`regionSurface${row}`),
      )

      If(amount.greaterThan(0.0002), () => {
        const surfaceStrokeFlag = regionShape.w
        const plantGain = amount.mul(surfaceStrokeFlag.oneMinus())
        const surfaceGain = amount.mul(surfaceStrokeFlag)
        // Far gentler than the brush's.
        //
        // The stroke kernel's 0.32 and 0.9 are calibrated for a hundred small
        // overlapping dabs, where the displacement accumulates gradually. A
        // region lays one decisive pass per channel, so the same numbers apply
        // a whole recipe's worth of competition in three or four steps: a
        // moss wash at 0.7 took ninety per cent of the leaf litter under it in
        // one dispatch, and a floor described as deep litter with moss on it
        // came out as moss on bare rock.
        const plantCompetition = clamp(plantGain.mul(0.12).oneMinus(), 0, 1)
        const surfaceCompetition = clamp(surfaceGain.mul(0.35).oneMinus(), 0, 1)
        const selected = int(regionChannel)
        const one = float(1)
        const zero = float(0)
        const channelMask = (row: number, weight: ShaderValue): ShaderValue => vec4(
          select(selected.equal(int(row * 4)), one, zero),
          select(selected.equal(int(row * 4 + 1)), one, zero),
          select(selected.equal(int(row * 4 + 2)), one, zero),
          select(selected.equal(int(row * 4 + 3)), one, zero),
        ).mul(weight)
        rows.forEach((current, row) => {
          current.assign(
            clamp(current.mul(plantCompetition).add(channelMask(row, plantGain)), 0, 1),
          )
        })
        surfaceRows.forEach((current, row) => {
          current.assign(
            clamp(
              current.mul(surfaceCompetition).add(channelMask(row, surfaceGain)),
              0,
              1,
            ),
          )
        })
      })

      const coord = ivec2(int(cellX), int(cellY))
      rows.forEach((current, row) => {
        buffer.element(base.add(uint(row))).assign(current)
        textureStore(weights[row]!, coord, current)
      })
      surfaceRows.forEach((current, row) => {
        surfaceBuffer.element(surfaceBase.add(uint(row))).assign(current)
        textureStore(surfaces[row]!, coord, current)
      })
      storeSward(coord, rows)
    })().compute(cells)
  }

  /** Uploads the shape subsequent `paintRegion` calls write through. */
  setRegion(
    centreX: number,
    centreZ: number,
    width: number,
    depth: number,
    coverage: (x: number, z: number) => number,
  ): void {
    this.region.update(centreX, centreZ, width, depth, coverage)
  }

  /** Lays one channel over the uploaded shape. One dispatch. */
  paintRegion(
    renderer: Renderer,
    options: {
      channel: number
      layer: FoliagePaintLayer
      /** Peak weight inside the shape, 0..1. */
      weight: number
      /** Metres of the break-up noise. */
      noiseScale?: number
      /** How much of the weight the noise is allowed to take away, 0..1. */
      noiseAmount?: number
    },
  ): void {
    if (this.disposed) return
    this.regionChannel.value = options.channel
    this.regionShape.value.set(
      Math.min(Math.max(options.weight, 0), 1),
      Math.max(options.noiseScale ?? 24, 1),
      Math.min(Math.max(options.noiseAmount ?? 0.45, 0), 1),
      options.layer === 'surface' ? 1 : 0,
    )
    renderer.compute(this.regionKernel)
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
    this.strokeSurface.value = stroke.layer === 'surface' ? 1 : 0
    renderer.compute(this.paintKernel)
  }

  /** Moves the window. The caller is responsible for repainting into it. */
  setOrigin(x: number, z: number): void {
    this.originX = x
    this.originZ = z
    this.origin.value.set(x, z)
  }

  /** Lays the given channel over the whole field, or clears it when erasing. */
  fill(
    renderer: Renderer,
    species: number,
    mode: FoliagePaintMode,
    layer: FoliagePaintLayer = 'plants',
  ): void {
    this.paint(renderer, {
      fromX: this.originX,
      fromZ: this.originZ,
      toX: this.originX,
      toZ: this.originZ,
      radius: this.fieldSize,
      flow: 1,
      hardness: 0.98,
      species,
      layer,
      mode,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const texture of this.weights) texture.dispose()
    for (const texture of this.surfaces) texture.dispose()
    this.sward.dispose()
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
