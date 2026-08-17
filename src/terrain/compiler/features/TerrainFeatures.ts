import type { AABB, Vec3Like } from '../../core/types'
import {
  cutterBounds,
  unionBounds,
  type CutterVolume,
} from '../../modifiers/boolean/CutterVolume'
import { sampleHeightFieldCached, type HeightFieldSample } from '../heightField'

/**
 * Procedural landform features: the parts of the world a heightfield cannot say.
 *
 * Placement is not a scatter. Every formation is gated on the quantity that
 * actually controls it in nature, read from the same height stack the terrain
 * was built from — a cave follows a weak bed and a drainage line, an arch needs
 * a genuine fin to be cut through, an undercut needs a cliff with a soft bed at
 * its foot, a canyon needs a channel with catchment above it. Scattering the
 * same shapes on noise alone produces caves in the middle of meadows and arches
 * standing in open ground, and the eye rejects both immediately.
 *
 * Features are defined purely in world space on a global lattice, so two
 * neighbouring sections independently generate a shared formation identically
 * and the seam closes without any communication between them.
 */

export type TerrainFeatureKind =
  | 'cave'
  | 'arch'
  | 'overhang'
  | 'canyon'
  | 'hoodoo'

export interface TerrainFeature {
  id: string
  kind: TerrainFeatureKind
  /** World bounds of everything this feature removes. */
  bounds: AABB
  cutters: CutterVolume[]
}

/**
 * Lattice cell size per kind, in metres, and how much of each cell passes the
 * roll before geology is even consulted. Larger cells mean rarer, and each kind
 * gets its own lattice so an undercut being common cannot make arches common.
 */
const FEATURE_LATTICE: Record<
  TerrainFeatureKind,
  { cell: number; chance: number }
> = {
  cave: { cell: 240, chance: 0.72 },
  arch: { cell: 190, chance: 0.85 },
  overhang: { cell: 130, chance: 0.88 },
  canyon: { cell: 380, chance: 0.62 },
  hoodoo: { cell: 300, chance: 0.68 },
}

/**
 * Largest distance any cutter can reach from its lattice anchor, in metres.
 *
 * Sized for a world whose mountains are 470 m tall and whose sections are only
 * 128 m across: a formation has to be hundreds of metres to register at all
 * from the distances this terrain is actually viewed from.
 *
 * This is a hard correctness invariant, not a tuning knob. A section only
 * considers anchors within this distance of itself, so if a formation can reach
 * further than this then one section will subtract it and its neighbour will
 * not — and the shared edge tears open. The longest reach belongs to a canyon:
 * its centre is offset up to `length * 0.25` from the anchor and its box then
 * extends a further `length`, so the bound must clear both. Anything added here
 * that can reach further must raise this value with it.
 */
const MAX_FEATURE_REACH = 900

/**
 * Every feature whose removed volume can touch `bounds`.
 *
 * The query is expanded by the maximum reach so a formation anchored in a
 * neighbouring cell but extending into this one is still returned.
 */
export function sampleTerrainFeatures(
  bounds: AABB,
  seed: number,
): TerrainFeature[] {
  const features: TerrainFeature[] = []
  for (const kind of Object.keys(FEATURE_LATTICE) as TerrainFeatureKind[]) {
    const { cell, chance } = FEATURE_LATTICE[kind]
    const minCellX = Math.floor((bounds.min.x - MAX_FEATURE_REACH) / cell)
    const maxCellX = Math.floor((bounds.max.x + MAX_FEATURE_REACH) / cell)
    const minCellZ = Math.floor((bounds.min.z - MAX_FEATURE_REACH) / cell)
    const maxCellZ = Math.floor((bounds.max.z + MAX_FEATURE_REACH) / cell)

    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        const random = cellRandom(cellX, cellZ, seed, kind)
        if (random(0) > chance) continue
        // Jitter well inside the cell so anchors never land on a lattice line,
        // which would make the placement legible as a grid.
        const anchorX = (cellX + 0.15 + random(1) * 0.7) * cell
        const anchorZ = (cellZ + 0.15 + random(2) * 0.7) * cell
        const feature = buildFeature(kind, anchorX, anchorZ, seed, random)
        if (feature && overlaps(feature.bounds, bounds)) features.push(feature)
      }
    }
  }
  return features
}

function buildFeature(
  kind: TerrainFeatureKind,
  x: number,
  z: number,
  seed: number,
  random: (index: number) => number,
): TerrainFeature | null {
  const site = sampleHeightFieldCached(x, z, seed)
  const cutters = (() => {
    switch (kind) {
      case 'cave':
        return buildCave(x, z, seed, site, random)
      case 'arch':
        return buildArch(x, z, seed, site, random)
      case 'overhang':
        return buildOverhang(x, z, seed, site, random)
      case 'canyon':
        return buildCanyon(x, z, seed, site, random)
      case 'hoodoo':
        return buildHoodoos(x, z, seed, site, random)
    }
  })()
  if (!cutters || cutters.length === 0) return null
  const bounds = unionBounds(cutters.map(cutterBounds))
  if (!bounds) return null
  return {
    id: `${kind}:${Math.round(x)}:${Math.round(z)}`,
    kind,
    bounds,
    cutters,
  }
}

/**
 * Cave: a passage following a weak bed into the massif.
 *
 * The mouth is placed on a steep face — caves open on cliffs and gorge walls,
 * not on open hillside — and the passage then runs *along the bedding dip*,
 * because that is where dissolution actually works: down the permeable bed
 * between two impermeable ones. Both ends break the surface, so the passage is
 * enterable rather than a pocket.
 */
function buildCave(
  x: number,
  z: number,
  seed: number,
  site: HeightFieldSample,
  random: (index: number) => number,
): CutterVolume[] | null {
  if (site.massif < 0.42) return null
  if (site.steepness < 0.55) return null

  const gradient = surfaceGradient(x, z, seed, 16)
  const intoHill = normalize2({ x: gradient.x, z: gradient.z })
  if (!intoHill) return null

  const radius = 18 + random(3) * 27
  // The dip direction is the horizontal component of the bedding plane's
  // steepest descent, which is the direction a phreatic passage prefers.
  const dip = normalize2({ x: site.bedding.normalX, z: site.bedding.normalZ })
  const dipDrop = Math.tan(Math.acos(Math.min(1, site.bedding.normalY)))

  const mouth: Vec3Like = {
    x,
    y: site.height - radius * 0.35,
    z,
  }
  // Start just outside the surface so the capsule certainly breaks through and
  // leaves an open mouth rather than a thin skin over the passage.
  const entry: Vec3Like = {
    x: mouth.x - intoHill.x * radius * 1.4,
    y: mouth.y + radius * 0.5,
    z: mouth.z - intoHill.z * radius * 1.4,
  }

  const runIn = 90 + random(4) * 130
  const heading = dip ?? intoHill
  const knee: Vec3Like = {
    x: mouth.x + intoHill.x * runIn,
    y: mouth.y - runIn * 0.16,
    z: mouth.z + intoHill.z * runIn,
  }
  const runAlong = 120 + random(5) * 180
  const deep: Vec3Like = {
    x: knee.x + heading.x * runAlong,
    y: knee.y - runAlong * Math.min(0.42, dipDrop * 0.55),
    z: knee.z + heading.z * runAlong,
  }

  // A second mouth wherever the passage has come back near the surface. If the
  // terrain there is still well above the passage the cave simply ends, which
  // is the honest outcome and still leaves an enterable dead end.
  const exitSite = sampleHeightFieldCached(deep.x, deep.z, seed)
  const cutters: CutterVolume[] = [
    { kind: 'capsule', start: entry, end: knee, radius, surface: 'cave' },
    { kind: 'capsule', start: knee, end: deep, radius: radius * 0.88, surface: 'cave' },
  ]
  if (exitSite.height - deep.y < radius * 5) {
    cutters.push({
      kind: 'capsule',
      start: deep,
      end: { x: deep.x, y: exitSite.height + radius * 0.9, z: deep.z },
      radius: radius * 0.72,
      surface: 'cave',
    })
  }
  // A chamber where the passage turns; real conduits widen at junctions.
  cutters.push({
    kind: 'ellipsoid',
    center: knee,
    radii: { x: radius * 2.6, y: radius * 1.5, z: radius * 2.1 },
    forward: { x: heading.x, y: 0, z: heading.z },
    surface: 'cave',
  })
  return cutters
}

/**
 * Arch: a window punched through a fin.
 *
 * The gate is the whole point. A fin is a ridge that falls away steeply on both
 * flanks while staying high along its crest, so the terrain is probed on two
 * perpendicular axes and the formation is only placed where one axis drops hard
 * and the other does not. The tube then runs across the thin direction, and the
 * rock left above it is the span.
 */
function buildArch(
  x: number,
  z: number,
  seed: number,
  site: HeightFieldSample,
  random: (index: number) => number,
): CutterVolume[] | null {
  if (site.massif < 0.4) return null

  const probe = 26
  const heightAt = (px: number, pz: number) =>
    sampleHeightFieldCached(px, pz, seed).height
  const dropX =
    site.height - (heightAt(x + probe, z) + heightAt(x - probe, z)) * 0.5
  const dropZ =
    site.height - (heightAt(x, z + probe) + heightAt(x, z - probe)) * 0.5

  const thin = Math.max(dropX, dropZ)
  const along = Math.min(dropX, dropZ)
  // Falls away sharply across, holds its height along: that is a fin.
  if (thin < 10.5 || along > thin * 0.62) return null

  const acrossX = dropX >= dropZ
  const axis: Vec3Like = acrossX ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 }
  const radius = 34 + random(3) * 56
  // Sit the window below the crest so a solid span is left above it.
  const centreY = site.height - radius - 14 - random(4) * 40

  // The tube has to come out the other side. A fin test on two probe points
  // says the ridge is narrow *here*, but the rock at the height the window is
  // cut can still be far wider than the tube, and then the boolean bores a
  // blind adit instead of opening a window — which looks like a mine entrance,
  // not an arch. So the ridge is walked outwards along the axis until the
  // ground drops below the window on both sides, and the formation is abandoned
  // if it does not.
  const half = openingHalfLength(x, z, axis, centreY, seed)
  if (half === null) return null

  return [
    {
      kind: 'capsule',
      start: {
        x: x - axis.x * half,
        y: centreY,
        z: z - axis.z * half,
      },
      end: {
        x: x + axis.x * half,
        y: centreY,
        z: z + axis.z * half,
      },
      radius,
      surface: 'arch',
    },
  ]
}

/** Longest half-length at which both tube ends emerge into open air. */
const MAX_SPAN_HALF = 340

function openingHalfLength(
  x: number,
  z: number,
  axis: Vec3Like,
  windowY: number,
  seed: number,
): number | null {
  const breakout = (sign: number): number | null => {
    for (let reach = 20; reach <= MAX_SPAN_HALF; reach += 12) {
      const groundY = sampleHeightFieldCached(
        x + axis.x * reach * sign,
        z + axis.z * reach * sign,
        seed,
      ).height
      if (groundY < windowY) return reach
    }
    return null
  }
  const positive = breakout(1)
  const negative = breakout(-1)
  if (positive === null || negative === null) return null
  // Overshoot the far side so the mouth is a clean opening rather than a
  // membrane left where the capsule cap stops exactly at the surface.
  return Math.max(positive, negative) + 26
}

/**
 * Undercut: a notch taken out of the foot of a cliff.
 *
 * Basal sapping removes the weak bed at the bottom of a face and leaves
 * everything above it standing out over nothing. The notch is therefore
 * flattened against the bedding and elongated along the strike, so it follows
 * the same plane the material shades as a bed rather than cutting across it.
 */
function buildOverhang(
  x: number,
  z: number,
  seed: number,
  site: HeightFieldSample,
  random: (index: number) => number,
): CutterVolume[] | null {
  if (site.massif < 0.35) return null
  if (site.steepness < 0.78) return null
  if (site.bedding.expression < 0.3) return null

  const gradient = surfaceGradient(x, z, seed, 12)
  const intoHill = normalize2({ x: gradient.x, z: gradient.z })
  if (!intoHill) return null
  // Strike is horizontal and perpendicular to the dip, so the notch runs along
  // the face rather than boring into it.
  const strike = { x: -intoHill.z, y: 0, z: intoHill.x }

  const depth = 34 + random(3) * 48
  const height = 20 + random(4) * 34
  const length = 85 + random(5) * 135

  // The notch has to straddle the face. Dropping straight down from the anchor
  // only burrows further under the surface — on a slope, lower always means
  // deeper inside the rock — and the boolean then hollows a sealed bubble that
  // cannot be seen from anywhere. So the site is walked *down the slope* first
  // and the notch is centred on the surface it finds there, biting into the
  // face rather than under it.
  const walk = 26 + random(6) * 58
  const faceX = x - intoHill.x * walk
  const faceZ = z - intoHill.z * walk
  const faceY = sampleHeightFieldCached(faceX, faceZ, seed).height

  return [
    {
      kind: 'ellipsoid',
      center: {
        x: faceX + intoHill.x * depth * 0.35,
        y: faceY - height * 0.25,
        z: faceZ + intoHill.z * depth * 0.35,
      },
      radii: { x: length, y: height, z: depth },
      forward: strike,
      surface: 'overhang',
    },
  ]
}

/**
 * Slot canyon: a narrow incision along a channel.
 *
 * Cut as two stacked boxes — a narrow slot at the top over a wider one beneath.
 * A single box gives vertical walls and reads as a trench; the widened lower
 * box undercuts them, which is what makes a slot canyon look carved by water
 * rather than cut by a saw.
 */
function buildCanyon(
  x: number,
  z: number,
  seed: number,
  site: HeightFieldSample,
  random: (index: number) => number,
): CutterVolume[] | null {
  if (site.massif < 0.4) return null
  if (site.flow < 0.38) return null

  const gradient = surfaceGradient(x, z, seed, 20)
  // Water runs down the gradient, so the channel follows the descent direction.
  const downhill = normalize2({ x: -gradient.x, z: -gradient.z })
  if (!downhill) return null

  const length = 190 + random(3) * 240
  const width = 17 + random(4) * 30
  const depth = 105 + random(5) * 145
  const forward = { x: downhill.x, y: 0, z: downhill.z }
  const centre = {
    x: x + downhill.x * length * 0.25,
    z: z + downhill.z * length * 0.25,
  }
  const rim = sampleHeightFieldCached(centre.x, centre.z, seed).height

  return [
    {
      kind: 'box',
      center: { x: centre.x, y: rim - depth * 0.35, z: centre.z },
      halfExtents: { x: length, y: depth * 0.55, z: width },
      forward,
      surface: 'canyon',
    },
    {
      kind: 'box',
      center: { x: centre.x, y: rim - depth * 0.95, z: centre.z },
      halfExtents: { x: length * 0.92, y: depth * 0.45, z: width * 1.7 },
      forward,
      surface: 'canyon',
    },
  ]
}

/**
 * Hoodoos: columns left standing between overlapping shafts.
 *
 * Nothing here builds a pillar. A grid of vertical shafts is removed and the
 * rock that survives *between* them is the formation — which is exactly how
 * they form, the surrounding rock being carried away while a resistant caprock
 * protects the column beneath it. The shaft spacing therefore sets the column
 * thickness, and it is kept just wide enough that the columns cannot be severed.
 */
function buildHoodoos(
  x: number,
  z: number,
  seed: number,
  site: HeightFieldSample,
  random: (index: number) => number,
): CutterVolume[] | null {
  if (site.massif < 0.3) return null
  if (site.bedding.expression < 0.28) return null
  // Hoodoos stand on ground gentle enough to have held a bed to begin with;
  // a cliff face erodes by falling apart instead.
  if (site.steepness > 1.25) return null

  const shaftRadius = 17 + random(3) * 14
  // The shafts must *overlap*. Spaced further apart than their diameter they
  // leave broad ground between them and the result reads as a cratered field;
  // overlapping slightly means the only rock that survives is the narrow cusp
  // where four shafts meet, and those cusps are the spires.
  const spacing = shaftRadius * 1.82
  const extent = 2
  const cutters: CutterVolume[] = []

  for (let row = -extent; row <= extent; row += 1) {
    for (let column = -extent; column <= extent; column += 1) {
      // Drop the centre shaft of each cluster so the tallest column stands in
      // the middle rather than being cut out of it.
      if (row === 0 && column === 0) continue
      const jitter = cellRandom(row, column, seed, `hoodoo:${x}:${z}`)
      const shaftX = x + (column + jitter(0) * 0.4 - 0.2) * spacing
      const shaftZ = z + (row + jitter(1) * 0.4 - 0.2) * spacing
      const ground = sampleHeightFieldCached(shaftX, shaftZ, seed).height
      // Deep enough that the surviving cusps stand well clear of the floor.
      const depth = 72 + jitter(2) * 85
      cutters.push({
        kind: 'capsule',
        start: { x: shaftX, y: ground + shaftRadius * 0.6, z: shaftZ },
        end: { x: shaftX, y: ground - depth, z: shaftZ },
        radius: shaftRadius,
        surface: 'hoodoo',
      })
    }
  }
  return cutters
}

/** Horizontal gradient of the surface, pointing uphill. */
function surfaceGradient(
  x: number,
  z: number,
  seed: number,
  step: number,
): { x: number; z: number } {
  const east = sampleHeightFieldCached(x + step, z, seed).height
  const west = sampleHeightFieldCached(x - step, z, seed).height
  const north = sampleHeightFieldCached(x, z + step, seed).height
  const south = sampleHeightFieldCached(x, z - step, seed).height
  return {
    x: (east - west) / (2 * step),
    z: (north - south) / (2 * step),
  }
}

function normalize2(
  vector: { x: number; z: number },
): { x: number; z: number } | null {
  const length = Math.hypot(vector.x, vector.z)
  if (length < 1e-5) return null
  return { x: vector.x / length, z: vector.z / length }
}

function overlaps(a: AABB, b: AABB): boolean {
  return (
    a.min.x <= b.max.x &&
    a.max.x >= b.min.x &&
    a.min.z <= b.max.z &&
    a.max.z >= b.min.z
  )
}

/**
 * A stable stream of values for one lattice cell. Indexing rather than
 * advancing a cursor keeps every draw independent of how many draws came
 * before, so adding a parameter to one formation cannot change the placement of
 * any other.
 */
function cellRandom(
  cellX: number,
  cellZ: number,
  seed: number,
  salt: string,
): (index: number) => number {
  let saltHash = 0x811c9dc5
  for (let index = 0; index < salt.length; index += 1) {
    saltHash = Math.imul(saltHash ^ salt.charCodeAt(index), 0x01000193) >>> 0
  }
  return (index: number) => {
    let value = Math.imul(cellX | 0, 374_761_393)
    value = (value + Math.imul(cellZ | 0, 668_265_263)) | 0
    value = (value + Math.imul(seed | 0, 1_442_695_041)) | 0
    value = (value + Math.imul(index + 1, 2_246_822_519)) | 0
    value = (value ^ saltHash) | 0
    value = Math.imul(value ^ (value >>> 13), 1_274_126_177)
    return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296
  }
}
