import {
  evaluateTerrainLayerWeights,
  evaluateTerrainVegetationFields,
  type TerrainVegetationFields,
} from '../terrain/compiler/TerrainMaterialFields'
import { FOLIAGE_RASTER_RESOLUTION } from './foliageWorldRaster'
import { foliageSpeciesIndex, type FoliageSpeciesId } from './foliageSpecies'

/**
 * Grass on the open hillside, placed from the terrain's own classification.
 *
 * Until now the only plants in this world grew inside a forest spline, because
 * the ground cover was built for forests and its mask was rasterised from
 * `ForestRegion` shapes. Everything outside one was bare terrain material, so
 * a four-kilometre world had grass in a handful of painted stands and nowhere
 * else — and since the terrain material read every vegetated channel as tinted
 * rock, there was nothing to suggest the missing grass either.
 *
 * The placement rule is the one rule this file exists to enforce: **plants grow
 * where the shader paints vegetation, because both ask the same function.**
 * `evaluateTerrainLayerWeights` is what the section compiler bakes into the
 * vertex attributes the terrain material reads, and it is what decides the
 * species weights here. No second opinion about slope, moisture or altitude
 * exists anywhere in this file, so grass cannot drift away from the ground it
 * is standing on when either side is retuned.
 *
 * The one thing deliberately not reproduced is the talus probe. It needs an
 * upslope bearing from a mesh normal that this rasteriser does not have, and
 * omitting it means a scree fan keeps whatever grass its gradient alone would
 * allow — a slight over-planting on a handful of fans, against one extra
 * height-field sample per cell across the whole window.
 */

/**
 * Cells across the slow-field grid.
 *
 * The classifier is cheap and the fields feeding it are not: measured, the
 * fields cost about 11 µs a cell and the classification about 0.6 µs. But the
 * fields are also the *slow* half by construction — their shortest wavelength
 * is the 46 m deposition band — so evaluating them on a 21 m lattice and
 * interpolating loses nothing a 4 m lattice would have shown, and turns a
 * 720 ms window into a 12 ms one. The classification still runs per cell at
 * full resolution, which is what keeps the metre-scale fray on the vegetation
 * edges that the eye actually reads.
 */
const FIELD_RESOLUTION = 48

/** How many horizontal bands one window fill is chunked into. */
export const GRASSLAND_BANDS = 8

interface GrasslandRule {
  id: FoliageSpeciesId
  /**
   * Share of the lush and dry vegetated channels this plant takes.
   *
   * Both, for most of them. The classifier's grass/meadow split is wet pasture
   * against dry pasture, and almost nothing growing on a hillside respects that
   * boundary absolutely — what changes across it is the mix, which is what
   * these two numbers are.
   */
  lush: number
  dry: number
  /** Preference along the water gradient: -1 dry ground, +1 wet ground. */
  water: number
  /** Preference along the altitude gradient: -1 valley, +1 near the treeline. */
  altitude: number
  /** Metres of the break-up noise the region kernel applies. */
  noiseScale: number
  noiseAmount: number
}

/**
 * What grows on open ground, and where.
 *
 * The shares are scaled so that the seven of them together come to a little
 * over one on fully vegetated ground rather than to nearly three. They are not
 * independent probabilities: the mask sums them, and the sum is both how many
 * plants stand here and — through `FoliageMaskField.sward` — how much of the
 * ground the plants are taken to cover. Written as seven plausible-looking
 * abundances they summed to 2.8, which saturated the sum everywhere and made
 * every vegetated acre in the world equally, maximally grassy.
 *
 * The woodland species — fern, moss, wood-rush, bramble, bracken — are absent
 * on purpose. They belong to the forest floor recipes, which already place them
 * under a canopy from the field presets, and scattering them across open
 * hillside is both wrong and the fastest way to make a forest stop reading as
 * one: a stand is legible because its floor differs from the ground around it.
 */
const GRASSLAND: readonly GrasslandRule[] = [
  // The default pasture: what a wet alpine valley floor is made of.
  { id: 'meadow-fescue', lush: 0.62, dry: 0.24, water: 0.55, altitude: -0.3, noiseScale: 34, noiseAmount: 0.4 },
  // A mat, so it fills between the tussocks rather than patching over them.
  { id: 'clover-mat', lush: 0.3, dry: 0.07, water: 0.7, altitude: -0.55, noiseScale: 22, noiseAmount: 0.35 },
  // Tussock is the alpine grass: it takes over as the fescue gives out toward
  // the treeline, which is what stops the high slopes reading as thin lawn.
  { id: 'tussock', lush: 0.12, dry: 0.44, water: -0.2, altitude: 0.75, noiseScale: 26, noiseAmount: 0.5 },
  // Dry pasture and the sunward spurs.
  { id: 'dry-steppe', lush: 0.05, dry: 0.4, water: -0.85, altitude: 0.15, noiseScale: 40, noiseAmount: 0.45 },
  // Colour, sparsely. A meadow with no flower in it reads as mown.
  { id: 'wildflower', lush: 0.16, dry: 0.13, water: 0.2, altitude: -0.1, noiseScale: 17, noiseAmount: 0.62 },
  // Only where the water table is at the surface — the strip beside a river.
  { id: 'sedge-reed', lush: 0.28, dry: 0.01, water: 1, altitude: -0.8, noiseScale: 19, noiseAmount: 0.55 },
  // Broken and disturbed ground: the toe of a slope, the edge of a scar.
  { id: 'broadleaf-weed', lush: 0.14, dry: 0.11, water: 0.15, altitude: -0.35, noiseScale: 14, noiseAmount: 0.6 },
]

export interface GrasslandChannel {
  channel: number
  weight: number
  noiseScale: number
  noiseAmount: number
  coverage: (x: number, z: number) => number
}

/**
 * The classification of one ground-cover window, cached per cell.
 *
 * Held rather than recomputed per species because seven species over a 256²
 * window is 460,000 classifications, and they would all be of the same seven
 * numbers. Filling once and deriving each species from the cache turns the
 * per-species cost into a multiply.
 */
export class TerrainGrasslandField {
  readonly resolution = FOLIAGE_RASTER_RESOLUTION

  /** Lush and dry vegetated coverage, straight from the classifier. */
  private readonly lush = new Float32Array(
    FOLIAGE_RASTER_RESOLUTION * FOLIAGE_RASTER_RESOLUTION,
  )
  private readonly dry = new Float32Array(
    FOLIAGE_RASTER_RESOLUTION * FOLIAGE_RASTER_RESOLUTION,
  )
  /** Signed water and altitude gradients, -1..1, for the habitat preferences. */
  private readonly water = new Float32Array(
    FOLIAGE_RASTER_RESOLUTION * FOLIAGE_RASTER_RESOLUTION,
  )
  private readonly altitude = new Float32Array(
    FOLIAGE_RASTER_RESOLUTION * FOLIAGE_RASTER_RESOLUTION,
  )

  private readonly fields: (TerrainVegetationFields | undefined)[] = new Array(
    FIELD_RESOLUTION * FIELD_RESOLUTION,
  )

  private originX = 0
  private originZ = 0
  private size = 1

  /**
   * Starts a new window. Discards the previous fill; call `fillBand` for every
   * band before reading a coverage.
   */
  begin(originX: number, originZ: number, size: number): void {
    this.originX = originX
    this.originZ = originZ
    this.size = Math.max(size, 1)
    this.fields.fill(undefined)
  }

  /**
   * Classifies one horizontal band of the window.
   *
   * Chunked because a whole window is tens of milliseconds and the caller is a
   * frame loop. The bands are independent, so they can be spread over as many
   * frames as the caller likes without any partial-state hazard beyond the
   * obvious one: the coverage read back before every band has run describes a
   * partly-empty window.
   */
  fillBand(
    band: number,
    sampleHeight: (x: number, z: number) => number,
    seed: number,
  ): void {
    const resolution = this.resolution
    const rows = Math.ceil(resolution / GRASSLAND_BANDS)
    const firstRow = band * rows
    const lastRow = Math.min(resolution, firstRow + rows)
    const step = this.size / (resolution - 1)
    const minX = this.originX - this.size * 0.5
    const minZ = this.originZ - this.size * 0.5

    for (let row = firstRow; row < lastRow; row += 1) {
      const z = minZ + row * step
      const offset = row * resolution
      for (let column = 0; column < resolution; column += 1) {
        const x = minX + column * step
        const y = sampleHeight(x, z)
        const fields = this.fieldsAt(x, z, y, seed)

        // The mesh normal is not available here, so the classification uses the
        // height field's own — which is what the compiler falls back to for
        // every vertex whose slope history it cannot see, and is correct to
        // within the sculpting the user has done on top of it.
        const weights = evaluateTerrainLayerWeights(
          x,
          y,
          z,
          fields.baseNormalY,
          0,
          fields,
        )

        const index = offset + column
        this.lush[index] = weights.grass
        this.dry[index] = weights.meadow
        this.water[index] = fields.moisture * 2 - 1
        // Normalised against the band the plants actually care about rather
        // than the summit: everything above the treeline is equally "high" as
        // far as a grass is concerned, and there is no grass up there anyway.
        this.altitude[index] = Math.min(
          1,
          Math.max(-1, (y - GRASSLAND_LOW) / (GRASSLAND_HIGH - GRASSLAND_LOW) * 2 - 1),
        )
      }
    }
  }

  /**
   * The slow fields, on their own coarse lattice, memoised.
   *
   * Nearest rather than bilinear: these feed a classifier that is itself
   * smoothed by a metre-scale fray, and the 21 m cell is already four times
   * finer than the shortest wavelength in the fields it is sampling. The seam
   * a nearest lookup leaves is below what the fray covers.
   */
  private fieldsAt(
    x: number,
    z: number,
    y: number,
    seed: number,
  ): TerrainVegetationFields {
    const last = FIELD_RESOLUTION - 1
    const u = (x - (this.originX - this.size * 0.5)) / this.size
    const v = (z - (this.originZ - this.size * 0.5)) / this.size
    const column = Math.min(last, Math.max(0, Math.round(u * last)))
    const row = Math.min(last, Math.max(0, Math.round(v * last)))
    const key = row * FIELD_RESOLUTION + column
    const cached = this.fields[key]
    if (cached) return cached
    const built = evaluateTerrainVegetationFields(x, y, z, seed)
    this.fields[key] = built
    return built
  }

  /** One paint job per species, ready for `FoliageMaskField`. */
  channels(): GrasslandChannel[] {
    return GRASSLAND.map((rule) => ({
      channel: foliageSpeciesIndex(rule.id),
      // The region kernel multiplies coverage by this, so the peak stays at one
      // and the shaping is all in the coverage.
      weight: 1,
      noiseScale: rule.noiseScale,
      noiseAmount: rule.noiseAmount,
      coverage: this.coverageFor(rule),
    }))
  }

  private coverageFor(rule: GrasslandRule): (x: number, z: number) => number {
    const resolution = this.resolution
    const last = resolution - 1
    return (x: number, z: number): number => {
      const u = (x - (this.originX - this.size * 0.5)) / this.size
      const v = (z - (this.originZ - this.size * 0.5)) / this.size
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0
      const column = Math.min(last, Math.max(0, Math.round(u * last)))
      const row = Math.min(last, Math.max(0, Math.round(v * last)))
      const index = row * resolution + column
      const base = this.lush[index]! * rule.lush + this.dry[index]! * rule.dry
      if (base <= 0.001) return 0
      // Habitat preference as a gain either side of one, never as a gate. A
      // hard cut on moisture or altitude draws a contour line across the
      // hillside in whichever species it cuts, and two species cut at the same
      // threshold in opposite directions draw the same line twice.
      const water = 1 + rule.water * this.water[index]!
      const altitude = 1 + rule.altitude * this.altitude[index]!
      return Math.min(1, Math.max(0, base * water * altitude))
    }
  }
}

/** Altitudes the habitat preference is measured between, in metres. */
const GRASSLAND_LOW = 0
const GRASSLAND_HIGH = 210
