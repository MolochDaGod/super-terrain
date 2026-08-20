import { Quaternion, Vector3 } from 'three'
import { sampleBedding } from '../compiler/heightField'
import { graniteVolume } from './graniteVolume'
import type { CutterVolume } from '../modifiers/boolean/CutterVolume'
import {
  createBooleanVolumeModifier,
  createRemeshModifier,
} from '../modifiers/factories'
import type { TerrainModifier } from '../modifiers/types'
import type { Vec3Like } from '../core/types'

/**
 * "The shard" — the authored hero landform.
 *
 * A tilted mass of fractured rock thrust out of the basin west of the massif,
 * pierced by two windows. Both the mass and the holes are exact CSG against the
 * analytic heightfield: added volumes for the rock, subtracted volumes for the
 * openings. Nothing here is a compiler special case.
 *
 * Every one of those volumes is a **granite topology**, not a primitive. The
 * primitive cutters are analytic surfaces with a few metres of noise laid over
 * them, and at this size that is exactly what they look like: a swept fin is a
 * tusk and a capsule bored through it is a drainpipe. The granite field is a
 * fractured solid — worley-bounded blocks with three displacement bands — so
 * scaling one up to two hundred metres gives a mass with real joints, spalled
 * faces and broken edges, and boring one *through* the fin leaves an opening
 * whose walls are fracture surfaces rather than a cylinder.
 *
 * The bedding is still not authored. Strata are a property of world position,
 * so a mass added here picks up the same beds the massif behind it has, cut
 * obliquely by its own faces.
 */

/** Foot of the mass, buried in the basin floor, and its crest. */
const SHARD_FOOT: Vec3Like = { x: 268, y: 4, z: 148 }
const SHARD_CREST: Vec3Like = { x: 452, y: 186, z: 212 }

const SHARD_AXIS = normalize(subtract(SHARD_CREST, SHARD_FOOT))
/** Horizontal normal of the fin: the direction its two broad faces look along. */
export const SHARD_FACE_NORMAL = normalize({
  x: SHARD_AXIS.z,
  y: 0,
  z: -SHARD_AXIS.x,
})
export const SHARD_CENTER: Vec3Like = {
  x: (SHARD_FOOT.x + SHARD_CREST.x) * 0.5,
  y: (SHARD_FOOT.y + SHARD_CREST.y) * 0.5,
  z: (SHARD_FOOT.z + SHARD_CREST.z) * 0.5,
}

/**
 * The mass itself: one granite solid stretched along the fin's long axis and
 * stood on end. Stretching the topology rather than the noise is what keeps the
 * fracture pattern coherent across the whole face.
 *
 * Built at module scope because the windows are placed *from* it. A window
 * whose centre is picked off the foot-to-crest line lands wherever that line
 * happens to run, and the line runs past both ends of an irregular solid, so
 * the bore can miss the rock entirely and leave the molten body hanging in mid
 * air. Measuring the solid's real extent along its own axis and placing the
 * windows inside that is the only way to be sure a hole is a hole.
 */
const SHARD_MASS = graniteVolume({
  rockSeed: 3,
  topologyDetail: 30,
  scale: { x: 72, y: 34, z: 48 },
  rotation: {
    x: 0,
    y: Math.atan2(SHARD_AXIS.x, SHARD_AXIS.z) + Math.PI * 0.5,
    z: Math.atan2(
      SHARD_CREST.y - SHARD_FOOT.y,
      Math.hypot(SHARD_CREST.x - SHARD_FOOT.x, SHARD_CREST.z - SHARD_FOOT.z),
    ),
  },
  position: SHARD_CENTER,
})

const MASS_SPAN = measureAlongAxis(SHARD_MASS, SHARD_AXIS)

/**
 * Where the two windows sit, as a fraction of the mass's half-extent along its
 * own long axis, measured from its centroid.
 */
const WINDOW_PLACEMENTS = [
  { along: -0.3, radius: 21, drop: -3, seed: 4 },
  { along: 0.26, radius: 13, drop: 7, seed: 6 },
]

export const SHARD_WINDOWS = WINDOW_PLACEMENTS.map((placement) => ({
  ...placement,
  center: {
    x: MASS_SPAN.centre.x + SHARD_AXIS.x * MASS_SPAN.halfExtent * placement.along,
    y:
      MASS_SPAN.centre.y +
      SHARD_AXIS.y * MASS_SPAN.halfExtent * placement.along +
      placement.drop,
    z: MASS_SPAN.centre.z + SHARD_AXIS.z * MASS_SPAN.halfExtent * placement.along,
  },
}))

/** Centroid of a baked CSG operand and its half-extent along one direction. */
function measureAlongAxis(
  volume: CutterVolume,
  axis: Vec3Like,
): { centre: Vec3Like; halfExtent: number } {
  if (volume.kind !== 'mesh') {
    return { centre: SHARD_CENTER, halfExtent: 1 }
  }
  const centre = { x: 0, y: 0, z: 0 }
  const count = volume.positions.length / 3
  for (let offset = 0; offset < volume.positions.length; offset += 3) {
    centre.x += volume.positions[offset]
    centre.y += volume.positions[offset + 1]
    centre.z += volume.positions[offset + 2]
  }
  centre.x /= count
  centre.y /= count
  centre.z /= count

  let minimum = Infinity
  let maximum = -Infinity
  for (let offset = 0; offset < volume.positions.length; offset += 3) {
    const projection =
      (volume.positions[offset] - centre.x) * axis.x +
      (volume.positions[offset + 1] - centre.y) * axis.y +
      (volume.positions[offset + 2] - centre.z) * axis.z
    minimum = Math.min(minimum, projection)
    maximum = Math.max(maximum, projection)
  }
  return { centre, halfExtent: Math.max(1, (maximum - minimum) * 0.5) }
}

export function createHeroShardModifiers(seed: number): TerrainModifier[] {
  const tilt = Math.atan2(
    SHARD_CREST.y - SHARD_FOOT.y,
    Math.hypot(SHARD_CREST.x - SHARD_FOOT.x, SHARD_CREST.z - SHARD_FOOT.z),
  )
  const strike = Math.atan2(SHARD_AXIS.x, SHARD_AXIS.z)

  const fin = createBooleanVolumeModifier({
    operation: 'add',
    volumes: [
      SHARD_MASS,
      // A second, smaller mass broken off at the foot. Two interfering solids
      // read as one block that split as it rose; a single one meets the basin
      // along a clean intersection curve and reads as a prop pushed in.
      graniteVolume({
        rockSeed: 5,
        topologyDetail: 30,
        scale: { x: 34, y: 20, z: 30 },
        rotation: { x: 0.14, y: strike, z: tilt * 0.45 },
        position: {
          x: SHARD_FOOT.x + SHARD_AXIS.x * 40,
          y: SHARD_FOOT.y + SHARD_AXIS.y * 40 + 4,
          z: SHARD_FOOT.z + SHARD_AXIS.z * 40,
        },
      }),
    ],
  })
  fin.id = 'demo-v3-hero-shard-mass'

  const beds = createBooleanVolumeModifier({ volumes: beddingNotches(seed) })
  beds.id = 'demo-v3-hero-shard-bedding'

  // Each window is a granite solid stretched into a bar and driven clean
  // through the thin direction of the fin, so both mouths are openings with a
  // broken lip and the passage between them is a fracture cavity.
  const windows = createBooleanVolumeModifier({
    volumes: SHARD_WINDOWS.map((window) =>
      graniteVolume({
        rockSeed: window.seed,
        topologyDetail: 30,
        scale: {
          x: window.radius * 0.9,
          y: window.radius * 0.78,
          z: 46,
        },
        rotation: { x: 0.2, y: Math.atan2(SHARD_FACE_NORMAL.x, SHARD_FACE_NORMAL.z), z: 0.1 },
        position: window.center,
      }),
    ),
  })
  windows.id = 'demo-v3-hero-shard-windows'

  // The windows are the focal point of the frame, so they get fine source
  // topology. The rest of the fin is legible from its silhouette and would gain
  // nothing the eye can see from metre-scale vertices.
  //
  // Keep this tight. The adaptive grid is built per axis, so a density sphere
  // does not densify a disc — it densifies the full-width stripes of every
  // section it touches, and everything else those stripes cross is then cut
  // against a grid several times finer than it needs. Thirty metres of margin
  // at 0.85 m spacing was reaching into two neighbouring sections and roughly
  // tripling what the outcrops around the shard cost to compile.
  const density = SHARD_WINDOWS.map((window, index) => {
    const modifier = createRemeshModifier({
      center: window.center,
      radius: window.radius + 14,
      targetEdgeLength: 1.05,
    })
    modifier.id = `demo-v3-hero-shard-density-${index}`
    return modifier
  })

  return [...density, fin, beds, windows]
}

/**
 * Bedding, cut rather than modelled.
 *
 * The world already knows the attitude of the beds here — `sampleBedding`
 * returns their dip, strike and true thickness — so the partings are removed
 * with a stack of flattened solids lying *in* that plane, one per bed. Because
 * the planes are tilted and the fin's faces are not parallel to them, each
 * parting's outcrop trace runs obliquely across the face, widens where the face
 * lies near the bedding and pinches out where it does not. A horizontal notch
 * would instead read as a contour line drawn on the rock.
 *
 * The solids are granite topologies, so a parting is a broken, uneven recess
 * that varies along its length rather than a machined groove.
 */
function beddingNotches(seed: number): CutterVolume[] {
  const bedding = sampleBedding(SHARD_CENTER.x, SHARD_CENTER.z, seed)
  const normal = new Vector3(
    bedding.normalX,
    bedding.normalY,
    bedding.normalZ,
  ).normalize()
  // Lay the solid's local +y along the bedding normal: local y is the axis the
  // flattening scale is applied to, so that is the axis that becomes thin.
  const orientation = new Quaternion().setFromUnitVectors(
    new Vector3(0, 1, 0),
    normal,
  )

  const notches: CutterVolume[] = []
  const count = 5
  const spacing = bedding.thickness
  const centre = new Vector3(SHARD_CENTER.x, SHARD_CENTER.y, SHARD_CENTER.z)
  for (let index = 0; index < count; index += 1) {
    const offsetAlongNormal = (index - (count - 1) / 2) * spacing
    const position = centre
      .clone()
      .addScaledVector(normal, offsetAlongNormal)
      // A little lateral wander so the beds are not a perfectly regular stack.
      .addScaledVector(
        new Vector3(SHARD_FACE_NORMAL.x, 0, SHARD_FACE_NORMAL.z),
        Math.sin(index * 1.7) * 5,
      )
    notches.push(
      graniteVolume({
        rockSeed: 1 + (index % 7),
        topologyDetail: 20,
        // Wide in the bedding plane, and only a couple of metres thick across
        // it: that thinness is what makes it a parting rather than a cave.
        // Deliberately smaller than the mass's own cross-section. A parting
        // wider than the block it cuts does not leave a ledge, it saws the
        // block into free-floating plates — which is exactly what a viewer
        // reads as broken geometry hanging in mid air.
        scale: {
          x: 44,
          y: 2.4 + (index % 3) * 0.8,
          z: 30,
        },
        rotation: { x: 0, y: 0, z: 0 },
        orientation,
        position: { x: position.x, y: position.y, z: position.z },
      }),
    )
  }
  return notches
}

function subtract(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function normalize(value: Vec3Like): Vec3Like {
  const length = Math.hypot(value.x, value.y, value.z) || 1
  return { x: value.x / length, y: value.y / length, z: value.z / length }
}
