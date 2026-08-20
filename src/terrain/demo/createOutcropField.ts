import { sampleBedding, sampleHeightField } from '../compiler/heightField'
import { createBooleanVolumeModifier } from '../modifiers/factories'
import type { CutterVolume } from '../modifiers/boolean/CutterVolume'
import type { TerrainModifier } from '../modifiers/types'
import { SHARD_CENTER } from './createHeroShard'
import { graniteVolume } from './graniteVolume'
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
  score: number
}

/** Where crags are allowed: the basin walls and the ground rising to the massif. */
const REGION = { minX: 60, maxX: 640, minZ: -200, maxZ: 380 }
const SPACING = 52
/** Distinct source solids. Placement, not topology, is what varies these. */
const SEED_POOL = [2, 3, 5, 8, 11, 17]
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
function topologyForSize(size: number): 20 | 30 | 44 | 72 {
  // 72 was tried and is not affordable here: it puts eighteen thousand
  // triangles into every crag, and each one of those is cut exactly against
  // every section it touches. Forty-four is where the facets stop reading as
  // facets at these sizes.
  if (size >= 13) return 44
  return 30
}
const MAX_OUTCROPS = 38
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
export const OUTCROP_ID_PREFIX = 'demo-v4-outcrop-'
/** Prefixes of outcrop fields that shipped before this one. */
export const SUPERSEDED_OUTCROP_PREFIXES = ['demo-v3-outcrop-']

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
  return [...new Set(selectSites(seed).map((site) => clusterId(site.x, site.z)))]
}

export function createOutcropFieldModifiers(seed: number): TerrainModifier[] {
  const sites = selectSites(seed)
  const clusters = new Map<string, CutterVolume[]>()

  for (const [index, site] of sites.entries()) {
    const bedding = sampleBedding(site.x, site.z, seed)
    const wobble = hash(site.x, site.z, seed)
    // Stand the crag up in the plane of the local bedding: dip becomes the
    // tilt of the block and strike becomes its trend. Every outcrop in a real
    // range shares an attitude because they are all the same folded pile, and
    // scattering them at random angles is the single fastest way to make a
    // field of them look like scattered props.
    const rotation = {
      x: (wobble - 0.5) * 0.22,
      y: Math.atan2(bedding.normalX, bedding.normalZ) + (wobble - 0.5) * 0.5,
      z: Math.asin(Math.min(1, Math.max(-1, bedding.normalY))) - Math.PI * 0.5,
    }
    const volume = graniteVolume({
      rockSeed: SEED_POOL[index % SEED_POOL.length],
      topologyDetail: topologyForSize(site.size),
      // Wider than tall, and wider still along strike: a crag is a slice of a
      // bed left standing, not a boulder.
      // Flatter where the ground is: a rib pushing through a gentle slope is a
      // bed seen almost in plan, wide and low, not a block standing on end.
      // Bars are flatter still and drawn out along the current.
      scale: site.bar
        ? {
            x: site.size * (3.4 + wobble * 2.2),
            y: site.size * 0.5,
            z: site.size * (1.1 + wobble * 0.7),
          }
        : {
            x: site.size * (1.35 + wobble * 0.5),
            y: site.size * (site.size < 12 ? 0.55 : 1),
            z: site.size * (0.8 + wobble * 0.4),
          },
      rotation,
      position: {
        x: site.x,
        // Buried to just under half its height. Any less and it perches; any
        // more and it is a bump. This is where the join reads as bedrock
        // breaking through the slope rather than as a rock resting on it.
        //
        // Bars are placed against the waterline instead of against the ground,
        // because what matters about a bar is how far it stands out of the
        // water, and the floor under it is a metre or two either way.
        y: site.bar
          ? WATER_LEVEL - site.size * (0.14 + wobble * 0.34)
          : site.height - site.size * (0.34 + wobble * 0.16),
        z: site.z,
      },
    })

    const key = clusterId(site.x, site.z)
    const cluster = clusters.get(key)
    if (cluster) cluster.push(volume)
    else clusters.set(key, [volume])
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
  const sites: Site[] = []
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
      // The hero owns its own hillside; a crag there competes with it.
      if (Math.hypot(px - SHARD_CENTER.x, pz - SHARD_CENTER.z) < 150) continue

      const drowned = sample.height < WATER_LEVEL + 6
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
      if (gradient < 0.06) continue

      // Bigger crags on steeper, higher ground: those are the walls with enough
      // rock behind them to leave something that size standing. On the gentle
      // ground the same bed surfaces as a low rib a few metres high, which is
      // what actually happens where a slope is only just steep enough to strip.
      const size =
        4 +
        Math.min(1, gradient * 2.1) * 24 +
        Math.min(1, sample.height / 260) * 16 * jitter
      sites.push({
        x: px,
        z: pz,
        height: sample.height,
        size,
        // Deliberately weak on gradient. Scoring hard on it piles every crag
        // onto the handful of steepest faces and leaves the rest of the valley
        // exactly as bare as before.
        score: gradient * 0.8 + sample.height / 500 + jitter * 0.6,
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
