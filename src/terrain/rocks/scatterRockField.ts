import { gradientNoise, hash01 } from './glacialGraniteNoise'

/**
 * Where the loose rock on a hillside goes.
 *
 * The terrain material can make a slope look like stone and it cannot make it
 * *be* stone: every silhouette in the frame still belongs to the height field,
 * and a height field has no overhangs, no blocks standing proud of the surface
 * and no shadow cast by one rock onto another. That is the difference the eye
 * reads first, and no amount of normal mapping substitutes for it.
 *
 * So this places actual geometry — a few hundred instances of the meshes
 * `createScatterRockMesh` bakes — and the whole design problem is where.
 * Sprinkling uniformly is what makes scattered props look scattered: real
 * debris is the *product* of the slope it lies on, which means it obeys three
 * rules at once.
 *
 *   It comes from somewhere.  Rock falls off steep ground and comes to rest on
 *                             gentler ground below it, so the density peaks
 *                             just below a break in slope and thins both on
 *                             the cliff above and on the flat well beyond it.
 *   It arrives in batches.    One rockfall strews one apron. Clustering the
 *                             acceptance against a slow field is what makes a
 *                             hillside read as a series of events rather than
 *                             as a texture.
 *   It sorts by size.         Small clasts stay where they land; big blocks
 *                             roll and bounce further, so the largest rocks
 *                             sit furthest out and the fines bank up against
 *                             the foot of the face.
 *
 * Nothing here touches the GPU. Placement runs when the camera's window moves,
 * not per frame, and it samples the terrain's own height function directly
 * rather than a rasterised copy of it — which costs a few milliseconds on a
 * move and buys exact ground contact and a true surface normal on ground the
 * rasterised window would have flattened.
 */

export interface ScatterRockBand {
  name: string
  /** Metres, low and high, of the rock's long axis. */
  size: readonly [number, number]
  /** Metres between candidate slots. Larger rocks are rarer. */
  cell: number
  /** How far from the camera this band is drawn, in metres. */
  range: number
  /** Fraction of candidate slots that survive the gates, before clustering. */
  density: number
  /** Icosphere subdivisions for this band's meshes. See `createScatterRockMesh`. */
  subdivisions: number
  /** How deep the rock sits in the ground, as a fraction of its height. */
  burial: number
  /**
   * Bedrock coming through, rather than debris lying on top.
   *
   * The two obey opposite rules and cannot share a gate. Debris is
   * *depositional*: it needs somewhere above it to fall from and somewhere
   * gentle enough to come to rest. An outcrop is *erosional*: it appears
   * exactly where the ground is steep and convex, because a rib sheds its
   * cover and a hollow buries it. Placing outcrops with the debris gate puts
   * them in the gullies, which is where bedrock is least likely to be showing.
   */
  emergent?: boolean
  /**
   * Distinct baked meshes for this band.
   *
   * Repetition is noticed in proportion to how much of the screen one instance
   * covers, not to how many there are. Four shapes is invisible across eight
   * hundred pebbles and obvious across a dozen twenty-metre outcrops, so the
   * band with the fewest instances gets the most meshes — which also happens
   * to be affordable, because few instances is exactly when a larger library
   * costs little.
   */
  variants?: number
}

/**
 * The size bands, and why each one is drawn as far as it is.
 *
 * All four are debris — things lying *on* the ground. There was briefly a fifth
 * for emergent bedrock at six to twenty-five metres, added to break up a
 * silhouette that was still a smooth height field, and it has been removed
 * because `applyJointFaceting` now does that job in the height field itself and
 * does it properly. Scattered objects were never the right tool for it: an
 * outcrop is a piece of the landform, and a smooth blob standing on a faceted
 * slope reads worse than the same slope with nothing on it. This band stops
 * where the terrain's own structure begins.
 *
 * A band's range is set by when its rocks stop being resolvable, not by taste.
 * A fifteen-centimetre pebble is under a pixel past about twenty metres, and
 * five hundred of them beyond that point cost their full triangle budget to
 * contribute a faint stipple that the terrain material's own grain already
 * describes better. The large blocks earn the full range because a two-metre
 * boulder at seventy metres is still twenty pixels tall and still breaks a
 * silhouette.
 */
export const SCATTER_ROCK_BANDS: readonly ScatterRockBand[] = [
  {
    name: 'clast',
    size: [0.1, 0.3],
    cell: 0.62,
    range: 20,
    density: 0.42,
    subdivisions: 1,
    burial: 0.34,
  },
  {
    name: 'cobble',
    size: [0.3, 0.8],
    cell: 1.7,
    range: 38,
    density: 0.44,
    subdivisions: 2,
    burial: 0.3,
  },
  {
    name: 'block',
    size: [0.8, 2.1],
    cell: 4.4,
    range: 70,
    density: 0.46,
    subdivisions: 2,
    burial: 0.26,
  },
  {
    name: 'boulder',
    size: [2.1, 5.2],
    cell: 11,
    range: 70,
    density: 0.5,
    subdivisions: 3,
    burial: 0.22,
  },
]

/** Default distinct meshes per band; see `ScatterRockBand.variants`. */
export const SCATTER_ROCK_VARIANTS = 4

/** Meshes actually baked for a band. */
export function scatterRockVariants(band: ScatterRockBand): number {
  return band.variants ?? SCATTER_ROCK_VARIANTS
}

export interface ScatterRockInstance {
  x: number
  y: number
  z: number
  /** Uniform scale applied to the unit-ish baked mesh. */
  scale: number
  /** Rotation about world Y, radians. */
  yaw: number
  /** Surface normal the rock is bedded against. */
  normalX: number
  normalY: number
  normalZ: number
  /** Which of the band's baked meshes to draw. */
  variant: number
}

export interface ScatterRockSurface {
  height(x: number, z: number): number
  /** Rocks below this are underwater and are not drawn. */
  waterLevel?: number
}

export interface ScatterRockPlacement {
  band: ScatterRockBand
  instances: ScatterRockInstance[]
}

/**
 * Slope, and the height above the local low point, at one place.
 *
 * The normal comes from a symmetric difference at the band's own cell size
 * rather than at a fixed epsilon. Sampling a two-metre boulder's bedding plane
 * over ten centimetres reports the grain of the height field instead of the
 * shape of the ground it has to sit on, and the boulder ends up tilted by the
 * terrain's noise.
 */
function surfaceFrame(
  surface: ScatterRockSurface,
  x: number,
  z: number,
  reach: number,
): {
  height: number
  slope: number
  /** Positive on a rib or nose, negative in a gully. */
  curvature: number
  nx: number
  ny: number
  nz: number
} {
  const height = surface.height(x, z)
  const east = surface.height(x + reach, z)
  const west = surface.height(x - reach, z)
  const north = surface.height(x, z + reach)
  const south = surface.height(x, z - reach)
  const dx = (east - west) / (2 * reach)
  const dz = (north - south) / (2 * reach)
  const length = Math.hypot(dx, 1, dz)
  // Laplacian, normalised by the reach so it stays comparable between bands.
  // A ridge is where the ground is higher than the average of its neighbours.
  const curvature =
    (height * 4 - (east + west + north + south)) / reach
  return {
    height,
    slope: Math.min(1, Math.hypot(dx, dz)),
    curvature,
    nx: -dx / length,
    ny: 1 / length,
    nz: -dz / length,
  }
}

/**
 * Deposition likelihood at a point, in [0, 1].
 *
 * This is the "it comes from somewhere" rule made arithmetic. `slope` is the
 * gradient here; `above` is how much steeper the ground is a short way uphill.
 * A talus apron is the place where the second is large and the first is
 * moderate — directly below a face, on ground gentle enough to hold what the
 * face sheds. Bare cliff scores low because nothing rests on it, and a flat
 * meadow scores low because nothing above it is shedding.
 */
function deposition(slope: number, upslope: number): number {
  // Ground that can hold a rock at all: steep enough not to be a floodplain,
  // gentle enough not to shed everything it receives. The upper limit is
  // generous because "gentle enough" for a wedged block is a great deal
  // steeper than for a loose pebble, and the size bands already separate the
  // two by their own cell sizes.
  const holds = Math.max(
    0,
    Math.min(1, (slope - 0.03) / 0.14) * Math.min(1, (1.5 - slope) / 0.7),
  )
  // Something uphill supplying it concentrates the field, but its absence must
  // not empty the field: an even slope with no break above it is still made of
  // rock and still sheds it.
  const supply = Math.min(1, Math.max(0, (upslope - slope - 0.02) / 0.35))
  // Rock is also simply exposed on steep ground, independent of any apron, and
  // ledges catch what falls past them. Without this floor a cliff face itself
  // carries nothing, which is the opposite of what a broken face looks like.
  const ledge = Math.min(1, Math.max(0, (slope - 0.22) / 0.4)) * 0.8
  return Math.min(1, holds * (0.62 + supply * 0.6) + ledge)
}

/**
 * Exposure likelihood for bedrock, in [0, 1].
 *
 * The inverse of `deposition` in every term, and deliberately so. Rock shows
 * through where the ground is steep enough to shed its own cover and convex
 * enough to be shedding rather than collecting — a nose, a rib, the shoulder
 * above a gully. Flat ground is buried under whatever has washed onto it, and
 * a hollow is buried under whatever came off the ribs either side.
 */
function emergence(slope: number, curvature: number): number {
  const steep = Math.min(1, Math.max(0, (slope - 0.12) / 0.42))
  const convex = Math.min(1, Math.max(0, curvature * 6 + 0.35))
  return Math.min(1, steep * (0.35 + convex * 0.9))
}

/**
 * Places one band around a point.
 *
 * The grid is anchored to a world lattice rather than to the camera, so a slot
 * keeps its rock as the camera moves and the field does not reshuffle itself
 * under a pan. Everything a slot decides comes from a hash of its own lattice
 * cell, which is what makes that stability free.
 */
export function placeScatterRockBand(
  band: ScatterRockBand,
  centreX: number,
  centreZ: number,
  surface: ScatterRockSurface,
  seed: number,
): ScatterRockInstance[] {
  const instances: ScatterRockInstance[] = []
  const range = band.range
  const rangeSquared = range * range
  const minimumX = Math.floor((centreX - range) / band.cell)
  const maximumX = Math.ceil((centreX + range) / band.cell)
  const minimumZ = Math.floor((centreZ - range) / band.cell)
  const maximumZ = Math.ceil((centreZ + range) / band.cell)
  const waterLevel = surface.waterLevel ?? -Infinity
  // The reach the bedding normal is measured over: about the size of the rock,
  // so a boulder sits on the shape of the hillside and a clast on the shape of
  // the ledge it is lying on.
  const reach = Math.max(0.35, band.size[1] * 0.8)

  for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ += 1) {
    for (let cellX = minimumX; cellX <= maximumX; cellX += 1) {
      const jitterX = hash01(cellX, cellZ, 17, seed)
      const jitterZ = hash01(cellX, cellZ, 43, seed)
      const x = (cellX + 0.5 + (jitterX - 0.5) * 0.9) * band.cell
      const z = (cellZ + 0.5 + (jitterZ - 0.5) * 0.9) * band.cell
      const offsetX = x - centreX
      const offsetZ = z - centreZ
      if (offsetX * offsetX + offsetZ * offsetZ > rangeSquared) continue

      const accept = hash01(cellX, cellZ, 71, seed)
      if (accept > band.density) continue

      const frame = surfaceFrame(surface, x, z, reach)
      if (frame.height <= waterLevel) continue

      // How much steeper the ground is a few metres uphill, which is the
      // direction the gradient points away from.
      const uphillDistance = Math.max(2, band.size[1] * 3)
      const gradientLength = Math.hypot(frame.nx, frame.nz) || 1
      const uphill = surfaceFrame(
        surface,
        x - (frame.nx / gradientLength) * uphillDistance,
        z - (frame.nz / gradientLength) * uphillDistance,
        reach,
      )
      const likelihood = band.emergent
        ? emergence(frame.slope, frame.curvature)
        : deposition(frame.slope, uphill.slope)
      if (likelihood <= 0.01) continue

      // One rockfall strews one apron: a slow field, so acceptance comes in
      // patches tens of metres across rather than an even sprinkle.
      // Debris aprons are tens of metres across; a belt of outcropping
      // bedrock follows the structure and runs for hundreds. Sharing one
      // wavelength would either chop the belts into patches or spread the
      // aprons over the whole hillside.
      const clusterScale = band.emergent ? 0.004 : 0.021
      const cluster = Math.min(
        1,
        Math.max(
          0,
          gradientNoise(x * clusterScale, 0, z * clusterScale, seed + 991) * 1.6 +
            0.55,
        ),
      )
      const roll = hash01(cellX, cellZ, 137, seed)
      if (roll > likelihood * (0.42 + cluster * 0.78)) continue

      const sizeRoll = hash01(cellX, cellZ, 211, seed)
      // Biased to the small end of every band: a scree slope is mostly fines
      // with a few large clasts in it, never a uniform draw between the two.
      const size = band.size[0] +
        (band.size[1] - band.size[0]) * sizeRoll * sizeRoll
      const yaw = hash01(cellX, cellZ, 307, seed) * Math.PI * 2
      const variantCount = scatterRockVariants(band)
      const variant = Math.min(
        variantCount - 1,
        Math.floor(hash01(cellX, cellZ, 401, seed) * variantCount),
      )

      instances.push({
        x,
        y: frame.height - size * band.burial,
        z,
        scale: size,
        yaw,
        normalX: frame.nx,
        normalY: frame.ny,
        normalZ: frame.nz,
        variant,
      })
    }
  }

  return instances
}

/** Places every band around a point. */
export function placeScatterRocks(
  centreX: number,
  centreZ: number,
  surface: ScatterRockSurface,
  seed: number,
  bands: readonly ScatterRockBand[] = SCATTER_ROCK_BANDS,
): ScatterRockPlacement[] {
  return bands.map((band) => ({
    band,
    instances: placeScatterRockBand(band, centreX, centreZ, surface, seed),
  }))
}
