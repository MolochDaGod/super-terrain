import { Euler, Quaternion, Vector3 } from 'three'
import { sampleBedding, sampleHeightField } from '../compiler/heightField'
import { createBooleanVolumeModifier } from '../modifiers/factories'
import type { CutterVolume } from '../modifiers/boolean/CutterVolume'
import type { TerrainModifier } from '../modifiers/types'
import {
  THRUST_CENTER,
  THRUST_ROTATION,
  THRUST_TILT,
} from './createThrustFormation'
import { graniteVolume as createGraniteVolume } from './graniteVolume'
import { WATER_LEVEL } from './valleyFloor'

/**
 * The outcrop field.
 *
 * This is the thing the whole demo exists to show, and the hero shard alone
 * does not show it: one authored landform against an otherwise untouched height
 * field reads as a prop dropped onto a heightmap, which is exactly what it is.
 * The claim being made is that high-quality rock topology can be patched onto
 * procedural terrain *anywhere*, by exact CSG, at any scale, without the terrain
 * and the rock being two different surfaces meeting at a seam. So the valley
 * walls get thirty-odd of them, from bus-sized to fifty metres, and the eye is
 * meant to find rock structure wherever it lands rather than only at the hero.
 *
 * Nothing here is a special case in the compiler. Each outcrop is a granite
 * solid unioned into the field, so the terrain surface *becomes* the rock's
 * surface across the join and the transition is a real intersection curve
 * rather than a blend. Because the Boolean backend keeps the operand's own
 * triangles, the crag's fracture detail survives at whatever resolution the
 * section it lands in happens to be compiled at.
 */

interface Site {
  x: number
  z: number
  height: number
  size: number
  /** A gravel bar in the braid plain rather than a crag on a slope. */
  bar?: boolean
  /** A long, bedding-aligned sheet emerging through the terrain surface. */
  slab?: boolean
  /** One of the authored camera-visible slabs rather than a sampled site. */
  featured?: boolean
  /** A single deeply intersecting sheet on a steep upper-massif face. */
  massif?: boolean
  /** A complete genus-one granite body whose legs, not its void, meet ground. */
  arch?: boolean
  /** Reverses the structural dip so the exposed sheet rises against the train. */
  opposite?: boolean
  score: number
}

/**
 * Camera-visible bedding windows. The procedural selector still fills the
 * range, but these authored sites guarantee that the actual shipped frame
 * demonstrates mesh patches on both basin flanks and along the river instead
 * of trusting a top-N gradient lottery to put them somewhere visible.
 */
const FEATURED_SLABS = [
  // Camera-left thrust train. These are terrain-sized replacements with tall
  // faces and cantilevered leaves, not boulders scattered on a height field.
  { x: 455, z: -5, size: 64 },
  { x: 520, z: 75, size: 68 },
  { x: 565, z: 180, size: 64 },
  { x: 480, z: 310, size: 60 },
  { x: 420, z: 390, size: 64 },
  // Camera-right train. The foreground sheets climb out of the near basin and
  // continue behind the landmark, so the geological patch language spans the
  // whole shot instead of terminating at one hero object.
  // This counter-dipping sheet occupies the unmistakable foreground-right
  // bank. Its apron and buried root still fuse it into the basin, so the
  // reversed XYZ attitude reads as deformed terrain, not a mirrored prop.
  { x: 300, z: 10, size: 48, opposite: true },
  { x: 260, z: 125, size: 64 },
  { x: 195, z: 225, size: 58, arch: true },
  { x: 115, z: 315, size: 60 },
  { x: 245, z: 390, size: 60 },
  // Smaller transition patches close the gaps between the two trains. They
  // keep the middle distance from reverting to an untouched heightfield while
  // leaving the hero portals and river axis unobstructed.
  { x: 430, z: 40, size: 50 },
  { x: 350, z: 340, size: 52 },
] as const

/** Where crags are allowed: the basin walls and the ground rising to the massif. */
const REGION = { minX: 20, maxX: 640, minZ: -160, maxZ: 520 }
const SPACING = 48
/** Distinct source solids. Placement, not topology, is what varies these. */
// Large patches must stay genus-zero. Arch and bench archetypes contain real
// undercuts; stretching those across a hillside makes implausible hanging
// rails. Erratic, prow, tor and monolith remain closed natural formations.
const SEED_POOL = [1, 2, 4, 6, 7, 8]
// All remain closed natural granite formations, but mixing bench and prow
// cycles prevents the exposed patch silhouettes repeating like copied logs.
const FEATURED_PATCH_SEEDS = [5, 11, 2, 17, 8, 23, 5, 2, 11, 4, 17, 8] as const
const FEATURED_SHEET_SEEDS = [2, 4, 6, 7] as const
const FEATURED_ROOT_SEEDS = [2, 4, 8, 10] as const

/**
 * Camera-visible frost-shattered blocks along the two banks and foreground.
 * Each cluster is merged into one multi-component closed mesh before CSG, so
 * the ground genuinely owns every contact without paying one evaluator pass
 * per small stone.
 */
interface RubbleSite {
  x: number
  z: number
  size: number
  seed: number
  /** Root the body in the river bed while leaving its crown above water. */
  waterline?: boolean
}

const RUBBLE_SITES: readonly RubbleSite[] = [
  { x: 370, z: 35, size: 7.5, seed: 1 },
  { x: 430, z: 55, size: 5.2, seed: 4 },
  { x: 500, z: 20, size: 8.5, seed: 1 },
  { x: 150, z: 150, size: 6.4, seed: 4 },
  { x: 115, z: 190, size: 4.8, seed: 1 },
  { x: 180, z: 260, size: 7.2, seed: 4 },
  { x: 80, z: 280, size: 5.6, seed: 1 },
  { x: 260, z: 320, size: 8.2, seed: 4 },
  { x: 330, z: -30, size: 7.8, seed: 1 },
  { x: 280, z: -10, size: 5.4, seed: 4 },
  { x: 420, z: -20, size: 9.2, seed: 1 },
  { x: 145, z: 90, size: 4.6, seed: 4 },
  { x: 90, z: 160, size: 6.1, seed: 1 },
  // Low, deeply planted foreground blocks interrupt the remaining broad
  // heightfield spans. They are intentionally not props: each batch is merged
  // into the same exact terrain-union modifier as the large patch train.
  { x: 135, z: -70, size: 6.8, seed: 4 },
  { x: 215, z: -58, size: 8.4, seed: 1 },
  { x: 345, z: -78, size: 7.2, seed: 4 },
  { x: 470, z: -54, size: 9.1, seed: 1 },
  { x: 535, z: 115, size: 7.6, seed: 4 },
  { x: 235, z: 72, size: 5.8, seed: 1 },
  { x: 405, z: 118, size: 6.6, seed: 4 },
  { x: 65, z: 88, size: 5.2, seed: 1 },
  // Exact terrain-owned stepping stones break the reflective ribbon. Their
  // lower halves intersect the carved bed, so these are CSG shoreline/boulder
  // topology rather than props hidden just beneath the water plane.
  { x: 148, z: 60, size: 8.8, seed: 4, waterline: true },
  { x: 164, z: 120, size: 10.2, seed: 1, waterline: true },
  { x: 212, z: 180, size: 11.6, seed: 4, waterline: true },
] as const
/**
 * Source resolution, by finished size in metres.
 *
 * The generator's cell count is a resolution in its *own* unit cube, so a solid
 * blown up to forty metres carries the same triangle count as one left at four
 * and its facets are ten times as wide. Picking the detail from the placed size
 * is what keeps a crag's fracture faces the same size on screen as the granite
 * boulders standing next to it — otherwise the patched rock is visibly the
 * coarsest thing in a frame full of finer ones, which is the exact opposite of
 * the point being made.
 */
function topologyForSize(_size: number): 20 | 30 | 44 | 72 {
  // The full material supplies centimetre-scale fracture normals. Field sheets
  // are mostly buried and occupy tens of pixels, so a 20-cell closed source
  // retains their metre-scale silhouette while avoiding a second extraction
  // tier and substantially reducing every exact section Boolean they touch.
  return 20
}
// Twelve camera-authored patch complexes carry the composition. Four sampled
// sites are enough to keep the field from ending abruptly outside the frame;
// the previous extra sites added cold-start Boolean work but mostly landed
// behind the authored masses or beyond a useful screen size.
const MAX_OUTCROPS = 16
/**
 * Most crags one section may hold. Each one is a couple of thousand triangles
 * cut exactly against that section's grid, so an unbounded top-N selection
 * piles them into the few steepest walls and makes those sections many times
 * more expensive to compile than their neighbours — which is felt directly, as
 * one patch of the valley arriving long after the rest of it.
 */
const MAX_PER_CLUSTER = 4
/** Modifiers are cut on this grid so each one's bounds stay tight. */
const CLUSTER_SIZE = 200

/**
 * Version marker for the whole field. The cluster ids are what the saved-world
 * upgrade compares against, and reshaping the crags without changing them
 * leaves every existing world holding the old geometry under the current name —
 * so anything that changes what a crag *is*, and not just where it goes, bumps
 * this.
 */
export const OUTCROP_ID_PREFIX = 'demo-v23-outcrop-'
/** Prefixes of outcrop fields that shipped before this one. */
export const SUPERSEDED_OUTCROP_PREFIXES = [
  'demo-v3-outcrop-',
  'demo-v4-outcrop-',
  'demo-v5-outcrop-',
  'demo-v6-outcrop-',
  'demo-v7-outcrop-',
  'demo-v8-outcrop-',
  'demo-v9-outcrop-',
  'demo-v10-outcrop-',
  'demo-v11-outcrop-',
  'demo-v12-outcrop-',
  'demo-v13-outcrop-',
  'demo-v14-outcrop-',
  'demo-v15-outcrop-',
  'demo-v16-outcrop-',
  'demo-v17-outcrop-',
  'demo-v18-outcrop-',
  'demo-v19-outcrop-',
  'demo-v20-outcrop-',
  'demo-v21-outcrop-',
  'demo-v22-outcrop-',
]

/** Modifier id for the cluster a site falls in. */
function clusterId(x: number, z: number): string {
  return `${OUTCROP_ID_PREFIX}${Math.floor(x / CLUSTER_SIZE)}_${Math.floor(z / CLUSTER_SIZE)}`
}

/**
 * The ids this field will produce, without generating any geometry.
 *
 * The demo stack's version *is* its set of ids, so the upgrade path has to know
 * what the current field is called before deciding whether a saved world is
 * missing any of it. Site selection is a few hundred height-field samples;
 * building the solids is a hundred milliseconds each, so the two are separable
 * and this is the cheap half.
 */
export function outcropFieldModifierIds(seed: number): string[] {
  return [...new Set([
    ...selectSites(seed).map((site) => clusterId(site.x, site.z)),
    ...RUBBLE_SITES.map((site) => clusterId(site.x, site.z)),
  ])]
}

export function createOutcropFieldModifiers(seed: number): TerrainModifier[] {
  const sites = selectSites(seed)
  const clusters = new Map<string, CutterVolume[]>()

  for (const [index, site] of sites.entries()) {
    const bedding = sampleBedding(site.x, site.z, seed)
    const wobble = hash(site.x, site.z, seed)
    const size = site.bar
      ? site.size
      : Math.min(
          site.size,
          site.featured ? (site.massif ? 72 : 68) : site.slab ? 16 : 20,
        )
    // Stand the crag up in the plane of the local bedding: dip becomes the
    // tilt of the block and strike becomes its trend. Every outcrop in a real
    // range shares an attitude because they are all the same folded pile, and
    // scattering them at random angles is the single fastest way to make a
    // field of them look like scattered props.
    const rotation = site.bar
      ? {
          x: (wobble - 0.5) * 0.035,
          y: Math.atan2(bedding.normalX, bedding.normalZ),
          z: (wobble - 0.5) * 0.025,
        }
      : site.featured
        ? site.arch
          ? {
              // Present the natural opening to the shipped camera while the
              // whole body still leans and rolls through the terrain volume.
              x: THRUST_ROTATION[0] + (wobble - 0.5) * 0.04,
              y: THRUST_ROTATION[1] + 0.04 + (wobble - 0.5) * 0.06,
              z: THRUST_TILT * 0.62,
            }
          : site.massif
          ? {
              // Follow the local fold on the steep upper wall. A hero-parallel
              // sheet up here projects as a horizontal beam against the sky;
              // this attitude intersects the mountain face on a diagonal.
              x: (wobble - 0.5) * 0.12,
              y: Math.atan2(bedding.normalX, bedding.normalZ) +
                (wobble - 0.5) * 0.24,
              z: -0.42 - (index % 3) * 0.12,
            }
          : {
            x: THRUST_ROTATION[0] + (index % 2 === 0 ? -0.035 : 0.07) +
              (wobble - 0.5) * 0.06,
            y: THRUST_ROTATION[1] + ((index % 5) - 2) * 0.085 +
              (index >= 5 ? (index % 2 === 0 ? 0.18 : -0.22) : 0) +
              (wobble - 0.5) * 0.09,
            // A shallow fraction of the hero tilt still reads as a rock laid
            // on the height field. These sheets use the same steep structural
            // attitude, varied only enough to imply a folded thrust train.
            z: (site.opposite ? -THRUST_TILT : THRUST_TILT) *
              (0.58 + (index % 4) * 0.11) +
              (wobble - 0.5) * 0.08,
            }
        : {
            x: (wobble - 0.5) * 0.22,
            y: Math.atan2(bedding.normalX, bedding.normalZ) + (wobble - 0.5) * 0.5,
            z: Math.asin(Math.min(1, Math.max(-1, bedding.normalY))) - Math.PI * 0.5,
          }
    const position = {
      x: site.x,
      // A dipping sheet gains most of its visible rise from its long X axis,
      // not from its thickness. Bury the centre well below the sampled ground
      // so only a broken ledge and its high end emerge from the height field.
      y: site.bar
        ? WATER_LEVEL - size * (0.04 + wobble * 0.03)
        : site.arch
          // Only the two feet enter the base terrain. Raising the body keeps
          // the natural genus-one void as open air rather than letting the
          // height field (or a second overlapping solid) refill it.
          ? site.height + size * (0.15 + wobble * 0.025)
        : site.slab
          ? site.height - size * (
              site.featured
                ? site.massif
                  ? 0.58 + wobble * 0.04
                  : 0.5 + (index % 4) * 0.025 + wobble * 0.035
                : 0.3 + wobble * 0.09
            )
        : site.height - size * (0.34 + wobble * 0.16),
      z: site.z,
    }
    const orientation = site.featured
      ? new Quaternion().setFromEuler(
          new Euler(rotation.x, rotation.y, rotation.z, 'XYZ'),
        )
      : undefined
    const volume = graniteVolume({
      // Bench is itself a closed, fractured granite formation. Use that
      // natural topology for the low sheets and bars instead of squashing a
      // tall tor until it looks like a primitive block.
      rockSeed: site.featured
        // Bench is the closed granite archetype whose natural joint set forms
        // a sheet. Other archetypes remain useful for the buried roots, but a
        // tor enlarged to terrain scale reads as a giant boulder, not a patch.
        ? site.arch
          ? 3
          : site.massif
          ? FEATURED_SHEET_SEEDS[index % FEATURED_SHEET_SEEDS.length]
          : FEATURED_PATCH_SEEDS[index % FEATURED_PATCH_SEEDS.length]
        : site.slab || site.bar
          ? 5
          : SEED_POOL[index % SEED_POOL.length],
      // The visible patch family deliberately reuses the same source-5 and
      // source-2 LOD0 topologies already needed by the landmark. That keeps
      // metre-scale chips on a forty-metre CSG operand without introducing a
      // new cold-load extraction tier for every placement.
      topologyDetail: site.featured ? 30 : topologyForSize(size),
      // Wider than tall, and wider still along strike: a crag is a slice of a
      // bed left standing, not a boulder.
      // Flatter where the ground is: a rib pushing through a gentle slope is a
      // bed seen almost in plan, wide and low, not a block standing on end.
      // Bars are flatter still and drawn out along the current.
      scale: site.bar
        ? {
            x: size * (1.2 + wobble * 0.8),
            y: size * (0.12 + wobble * 0.06),
            z: size * (0.4 + wobble * 0.28),
          }
        : site.slab
          ? {
              // Slabs use the same local frame as the hero sheet: X/Y span
              // the exposed bedding face and Z is thickness. The previous
              // X/Z-wide, Y-thin scale was a horizontal heightfield rock that
              // became a narrow log when rotated into the thrust attitude.
              x: size * (
                site.arch
                  ? 0.92 + wobble * 0.08
                  : site.featured
                  ? site.massif
                    ? 1.04 + wobble * 0.12
                    : 0.96 + (index % 4) * 0.085 + wobble * 0.12
                  : 1 + wobble * 0.25
              ),
              y: size * (
                site.arch
                  ? 0.88 + wobble * 0.06
                  : site.featured
                  ? site.massif
                    ? 0.72 + wobble * 0.08
                    : 0.62 + (index % 3) * 0.075 + wobble * 0.08
                  : 0.45 + wobble * 0.14
              ),
              z: size * (site.arch
                ? 0.4 + wobble * 0.04
                : site.featured
                ? site.massif
                  ? 0.46 + wobble * 0.05
                  : 0.24 + (index % 3) * 0.035 + wobble * 0.035
                : 0.18 + wobble * 0.07),
            }
        : {
            x: size * (1.35 + wobble * 0.5),
            y: size * (size < 12 ? 0.55 : 1),
            z: size * (0.8 + wobble * 0.4),
          },
      rotation,
      orientation,
      position,
    })

    // The operand supplies arbitrary XYZ topology; this footprint makes the
    // source terrain rise into that topology before the exact union. Only the
    // main sheet owns an apron, so roots and cantilever leaves cannot stack the
    // displacement into a procedural mound.
    if (volume.kind === 'mesh' && site.slab && !site.arch && !site.bar) {
      const patchOrientation = orientation ?? new Quaternion().setFromEuler(
        new Euler(rotation.x, rotation.y, rotation.z, 'YXZ'),
      )
      const forward = new Vector3(1, 0, 0).applyQuaternion(patchOrientation)
      volume.terrainApron = {
        center: { ...position },
        forward: { x: forward.x, y: forward.y, z: forward.z },
        halfLength: size * (site.massif ? 0.68 : 0.7),
        halfWidth: size * (site.massif ? 0.3 : 0.28),
        falloff: size * (site.featured ? 0.38 : 0.32),
        lift: Math.min(8, size * (site.massif ? 0.09 : 0.12)),
      }
    }

    const key = clusterId(site.x, site.z)
    const cluster = clusters.get(key)
    const volumes = cluster ?? []
    volumes.push(volume)

    if (site.featured && orientation && !site.massif && !site.arch) {
      // The sheet itself is already buried through the base terrain and owns a
      // broad terrain apron, so a second fully hidden root changes no visible
      // topology. Earlier versions still Booleaned that redundant body through
      // every intersected section, making the hero/outcrop overlap the cold-
      // load tail. Keep the genuinely visible cantilever leaf; its near half
      // intersects the main sheet and remains one connected terrain solid.
      const direction = index % 2 === 0 ? 1 : -1
      // Alternating complexes expose a high parallel leaf. The root of the leaf
      // intersects the main sheet, while its far half remains above empty
      // space: a real cantilever/undercut that a height field cannot represent.
      if (index % 2 === 0) {
        const leafOffset = new Vector3(
          -direction * size * (0.24 + wobble * 0.08),
          size * (0.32 + wobble * 0.05),
          -size * (0.24 + wobble * 0.035),
        ).applyQuaternion(orientation)
        volumes.push(graniteVolume({
          rockSeed: FEATURED_SHEET_SEEDS[
            (index + 1) % FEATURED_SHEET_SEEDS.length
          ],
          topologyDetail: 20,
          scale: {
            x: size * (0.72 + wobble * 0.1),
            y: size * (0.3 + wobble * 0.06),
            z: size * (0.075 + wobble * 0.018),
          },
          rotation,
          orientation,
          position: {
            x: position.x + leafOffset.x,
            y: position.y + leafOffset.y + size * 0.08,
            z: position.z + leafOffset.z,
          },
        }))
      }

    }
    if (site.featured && orientation && site.massif) {
      // A second deeply buried natural body turns the upper-wall patch into a
      // fractured crag complex rather than one exposed blade. The two solids
      // overlap before the terrain union, so every visible ledge is owned by
      // one watertight terrain surface.
      const rootOffset = new Vector3(
        size * (0.18 + wobble * 0.05),
        -size * (0.2 + wobble * 0.04),
        size * (0.04 + wobble * 0.03),
      ).applyQuaternion(orientation)
      volumes.push(graniteVolume({
        rockSeed: FEATURED_ROOT_SEEDS[(index + 1) % FEATURED_ROOT_SEEDS.length],
        topologyDetail: 20,
        scale: {
          x: size * (0.7 + wobble * 0.08),
          y: size * (0.56 + wobble * 0.06),
          z: size * (0.43 + wobble * 0.04),
        },
        rotation,
        orientation,
        position: {
          x: position.x + rootOffset.x,
          y: position.y + rootOffset.y,
          z: position.z + rootOffset.z,
        },
      }))
    }
    if (!cluster) clusters.set(key, volumes)
  }

  const rubbleClusters = new Map<string, CutterVolume[]>()
  for (const rubble of RUBBLE_SITES) {
    const wobble = hash(rubble.x, rubble.z, seed + rubble.seed * 97)
    const volume = graniteVolume({
      rockSeed: rubble.seed,
      topologyDetail: 20,
      scale: {
        x: rubble.size * (1.08 + wobble * 0.28),
        y: rubble.size * (0.62 + wobble * 0.18),
        z: rubble.size * (0.78 + wobble * 0.24),
      },
      rotation: {
        x: (wobble - 0.5) * 0.22,
        y: wobble * Math.PI * 2,
        z: (hash(rubble.z, rubble.x, seed + 811) - 0.5) * 0.18,
      },
      position: {
        x: rubble.x,
        y: sampleHeightField(rubble.x, rubble.z, seed).height +
          (rubble.waterline
            ? rubble.size * (0.14 + wobble * 0.04)
            : -rubble.size * (0.22 + wobble * 0.08)),
        z: rubble.z,
      },
    })
    const key = clusterId(rubble.x, rubble.z)
    const batch = rubbleClusters.get(key) ?? []
    batch.push(volume)
    if (!rubbleClusters.has(key)) rubbleClusters.set(key, batch)
  }
  for (const [key, parts] of rubbleClusters) {
    const cluster = clusters.get(key) ?? []
    cluster.push(mergeMeshVolumes(parts))
    if (!clusters.has(key)) clusters.set(key, cluster)
  }

  return [...clusters.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, volumes]) => {
      const modifier = createBooleanVolumeModifier({ operation: 'add', volumes })
      modifier.id = key
      return modifier
    })
}

/**
 * Picks the crag sites off the height field itself, so they land where a real
 * one would: on ground steep enough to be shedding rock, above the water, and
 * out of the hero's own space.
 */
function selectSites(seed: number): Site[] {
  const sites: Site[] = FEATURED_SLABS.map((site, index) => ({
    ...site,
    height: sampleHeightField(site.x, site.z, seed).height,
    slab: true,
    featured: true,
    score: 4 - index * 0.001,
  }))
  for (let z = REGION.minZ; z <= REGION.maxZ; z += SPACING) {
    for (let x = REGION.minX; x <= REGION.maxX; x += SPACING) {
      const jitter = hash(x, z, seed)
      const jitterZ = hash(z, x, seed + 7)
      const px = x + (jitter - 0.5) * SPACING * 0.8
      const pz = z + (jitterZ - 0.5) * SPACING * 0.8

      const sample = sampleHeightField(px, pz, seed)
      // Deep water gets nothing. Everything from a little below the waterline
      // up is fair game, and the band right around it is what braids the
      // river: the basin floor is smooth enough that a single level either
      // floods all of it or none of it, so the bars the channels divide around
      // have to be put there. A low rib half-drowned in the shallows is
      // exactly what a real braid plain is made of.
      if (sample.height < WATER_LEVEL - 7) continue
      // Small sampled operands on high distant slopes expose only one sunlit
      // tip at this camera distance; their buried join disappears and the tip
      // reads as a floating bright shard. The authored patch train already
      // carries the massif composition, so keep stochastic fillers in the
      // near/middle basin where their terrain intersection is visible.
      if (sample.height > 130 && pz > 220) continue
      // The hero owns its own hillside; a crag there competes with it.
      if (Math.hypot(px - THRUST_CENTER.x, pz - THRUST_CENTER.z) < 142) continue

      const drowned = sample.height < WATER_LEVEL + 0.5
      const gradient = localGradient(px, pz, seed)
      if (drowned) {
        // A bar is wide, long and barely proud of the water. It is graded by
        // the current that built it, so it does not care about the slope.
        sites.push({
          x: px,
          z: pz,
          height: sample.height,
          size: 5 + jitter * 5,
          bar: true,
          score: 0.9 + jitterZ * 0.4,
        })
        continue
      }
      // Almost dead flat ground is river bar and gets nothing; everything with
      // any fall to it is fair game. Restricting this to genuinely steep ground
      // is what left the near flats as bare procedural swells — the exact thing
      // that reads as an untouched heightmap with a prop standing on it.
      if (gradient < 0.015) continue

      // Bigger crags on steeper, higher ground: those are the walls with enough
      // rock behind them to leave something that size standing. On the gentle
      // ground the same bed surfaces as a low rib a few metres high, which is
      // what actually happens where a slope is only just steep enough to strip.
      const size =
        7 +
        Math.min(1, gradient * 2.1) * 18 +
        Math.min(1, sample.height / 260) * 8 * jitter
      sites.push({
        x: px,
        z: pz,
        height: sample.height,
        size,
        slab: hash(px, pz, seed + 1_907) > 0.24,
        // Deliberately weak on gradient. Scoring hard on it piles every crag
        // onto the handful of steepest faces and leaves the rest of the valley
        // exactly as bare as before.
        score:
          gradient * 0.8 +
          sample.height / 500 +
          jitter * 0.6 +
          // The shipped view approaches from z=-100. Prefer the ground one to
          // three hundred metres *ahead* of it; rewarding ever-smaller z put
          // most of the previous field behind the camera and left only one
          // visible clump at the bottom edge of the frame.
          Math.max(0, 1 - Math.abs(pz - 55) / 225) * 0.62 +
          // Keep a smaller cohort on the distant wall so the mesh-patch
          // language continues into the shot rather than ending at the hero.
          Math.max(0, Math.min(1, (pz - 330) / 210)) * 0.16,
      })
    }
  }

  const perCluster = new Map<string, number>()
  const chosen: Site[] = []
  for (const site of sites.sort((left, right) => right.score - left.score)) {
    if (chosen.length >= MAX_OUTCROPS) break
    const key = clusterId(site.x, site.z)
    const used = perCluster.get(key) ?? 0
    if (used >= MAX_PER_CLUSTER) continue
    perCluster.set(key, used + 1)
    chosen.push(site)
  }
  return chosen
}

/** Rise over run of the height field across a crag-sized baseline. */
function localGradient(x: number, z: number, seed: number): number {
  const span = 14
  const east = sampleHeightField(x + span, z, seed).height
  const west = sampleHeightField(x - span, z, seed).height
  const north = sampleHeightField(x, z + span, seed).height
  const south = sampleHeightField(x, z - span, seed).height
  return Math.hypot(east - west, north - south) / (2 * span)
}

/** Deterministic 0..1 from a world position, so the field never reshuffles. */
function hash(x: number, z: number, seed: number): number {
  const value = Math.sin(x * 12.9898 + z * 78.233 + seed * 0.117) * 43758.5453
  return value - Math.floor(value)
}

/**
 * `generateGraniteRock` owns a planting frame, so the analytic body may carry
 * a harmless source-space centroid offset. At boulder scale that offset is
 * invisible; after a forty-metre non-uniform rotation it can move the exposed
 * end of a patch several metres away from its authored CSG intersection.
 * Recentring the baked operand makes `position` the actual body centre and
 * keeps roots, leaves and arches connected under arbitrary XYZ attitudes.
 */
function graniteVolume(
  options: Parameters<typeof createGraniteVolume>[0],
): CutterVolume {
  const volume = createGraniteVolume(options)
  if (volume.kind !== 'mesh' || volume.positions.length === 0) return volume
  const vertexCount = volume.positions.length / 3
  let centreX = 0
  let centreY = 0
  let centreZ = 0
  for (let offset = 0; offset < volume.positions.length; offset += 3) {
    centreX += volume.positions[offset]!
    centreY += volume.positions[offset + 1]!
    centreZ += volume.positions[offset + 2]!
  }
  centreX /= vertexCount
  centreY /= vertexCount
  centreZ /= vertexCount
  const dx = options.position.x - centreX
  const dy = options.position.y - centreY
  const dz = options.position.z - centreZ
  for (let offset = 0; offset < volume.positions.length; offset += 3) {
    volume.positions[offset] = volume.positions[offset]! + dx
    volume.positions[offset + 1] = volume.positions[offset + 1]! + dy
    volume.positions[offset + 2] = volume.positions[offset + 2]! + dz
  }
  return volume
}

/** One valid multi-component manifold from several disjoint closed rocks. */
function mergeMeshVolumes(volumes: readonly CutterVolume[]): CutterVolume {
  const positions: number[] = []
  const indices: number[] = []
  let vertexOffset = 0
  for (const volume of volumes) {
    if (volume.kind !== 'mesh') continue
    positions.push(...volume.positions)
    for (const index of volume.indices) indices.push(index + vertexOffset)
    vertexOffset += volume.positions.length / 3
  }
  return { kind: 'mesh', positions, indices }
}
