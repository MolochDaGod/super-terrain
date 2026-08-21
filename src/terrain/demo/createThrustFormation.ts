import {
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three'
import { createBooleanVolumeModifier } from '../modifiers/factories'
import type { TerrainModifier } from '../modifiers/types'
import type { CutterVolume } from '../modifiers/boolean/CutterVolume'
import { graniteVolume } from './graniteVolume'

/**
 * World-space authored mesh formation used by the shipped Mesh Terrain scene.
 *
 * This deliberately mirrors Epic's showcase grammar: a broad, oblique thrust
 * sheet rises out of the basin, retains a fractured crest and carries two true
 * openings. The solid, its proud bedding patches, and the openings all travel
 * through the terrain Boolean compiler. Nothing in this file is rendered as a
 * separate landmark mesh.
 */

export const THRUST_CENTER = { x: 335, y: 90, z: 180 }
export const THRUST_DEPTH = 82
/** Recess of the real CSG chamber light behind the camera-facing natural lip. */
export const THRUST_EMBER_DEPTH = THRUST_DEPTH * 0.34
export const THRUST_TILT = -Math.PI * 0.252
export const THRUST_ROTATION = [0.018, 0.82, THRUST_TILT] as const
/** Aligns aperture axes with screen-horizontal/vertical in the shipped view. */
export const THRUST_WINDOW_ROLL = Math.PI * 0.25

interface WindowShape {
  x: number
  y: number
  rx: number
  ry: number
  seed: number
}

const WINDOWS: readonly WindowShape[] = [
  // Kept well inside the thrust perimeter so the complete CSG lip surrounds
  // the emitter; the previous centre intersected the lower edge and exposed
  // glowing cavity faces outside the formation.
  { x: 70, y: 20, rx: 9.5, ry: 14.5, seed: 4 },
  { x: 28, y: -8, rx: 16, ry: 24, seed: 1 },
]

const orientation = new Quaternion().setFromEuler(
  new Euler(...THRUST_ROTATION, 'XYZ'),
)
const thrustForward = new Vector3(1, 0, 0).applyQuaternion(orientation)
const windowOrientation = orientation.clone().multiply(
  new Quaternion().setFromEuler(new Euler(0, 0, THRUST_WINDOW_ROLL, 'XYZ')),
)
const formationMatrix = new Matrix4().compose(
  new Vector3(THRUST_CENTER.x, THRUST_CENTER.y, THRUST_CENTER.z),
  orientation,
  new Vector3(1.08, 1.08, 1.08),
)

const faceNormal = new Vector3(0, 0, -1).transformDirection(formationMatrix)
export const THRUST_FACE_NORMAL = {
  x: faceNormal.x,
  y: faceNormal.y,
  z: faceNormal.z,
}

export const THRUST_WINDOWS = WINDOWS.map((window) => {
  const center = localToWorld(window.x, window.y, 0)
  return {
    center,
    radius: Math.max(window.rx, window.ry),
    rx: window.rx,
    ry: window.ry,
    seed: window.seed,
  }
})

export const THRUST_MODIFIER_IDS = [
  'showcase-v13-10-thrust-mass',
  'showcase-v13-20-thrust-partings',
  'showcase-v13-40-thrust-windows',
] as const

export function createThrustFormationModifiers(): TerrainModifier[] {
  const mass = createBooleanVolumeModifier({
    operation: 'add',
    volumes: [
      naturalVolume({
        // The landmark is deliberately an overlap of several modest granite
        // formations rather than one hero-sized stretched solid. Each source
        // keeps metre-scale facets when enlarged, and their unions leave the
        // broken crest, shoulders and bedding offsets that one smooth volume
        // could only fake in a normal map.
        rockSeed: 5,
        topologyDetail: 44,
        // A long, comparatively thin thrust sheet owns the silhouette. Keeping
        // the minor axes restrained prevents the central mass reading as an
        // upright tor while retaining a complete natural-granite surface.
        scale: { x: 142, y: 42, z: 21 },
        rotation: { x: 0, y: 0, z: 0 },
        orientation,
        position: localToWorld(-2, -4, 0),
        terrainApron: {
          // One broad footprint roots the complete overlapping formation. The
          // later mass operands intentionally carry none, so their overlaps do
          // not add multiple copies of the same terrain displacement.
          center: localToWorld(18, -45, 5),
          forward: {
            x: thrustForward.x,
            y: thrustForward.y,
            z: thrustForward.z,
          },
          halfLength: 112,
          halfWidth: 38,
          falloff: 46,
          lift: 9.5,
        },
      }),
      naturalVolume({
        // A prow continues the raised end. It intersects the central bench,
        // so this is one watertight CSG formation rather than a prop pile.
        rockSeed: 2,
        topologyDetail: 44,
        scale: { x: 70, y: 29, z: 17 },
        rotation: { x: 0, y: 0, z: 0 },
        orientation,
        position: localToWorld(-106, 39, 3),
      }),
      naturalVolume({
        // The opposite end is a tor-like block with a different joint set.
        // Its overlap carries both windows while avoiding a repeated bench
        // outline from one end of the thrust to the other.
        rockSeed: 4,
        topologyDetail: 30,
        scale: { x: 68, y: 36, z: 23 },
        rotation: { x: 0, y: 0, z: 0 },
        orientation,
        position: localToWorld(72, -20, 3),
      }),
      naturalVolume({
        // One continuous granite body owns both blind chambers. The earlier
        // portal rays crossed several thin overlapping lobes, so one cutter
        // exposed multiple disconnected orange fragments. This deeper body
        // supplies an unbroken face, walls and rear shell around both mouths.
        rockSeed: 5,
        topologyDetail: 30,
        scale: { x: 64, y: 43, z: 29 },
        rotation: { x: 0, y: 0, z: 0 },
        orientation,
        position: localToWorld(44, -1, 3),
      }),
      naturalVolume({
        // The buried root is another complete granite body. Unioning it below
        // the sheet makes the formation grow out of the terrain rather than
        // balancing on a single narrow contact.
        rockSeed: 1,
        topologyDetail: 20,
        scale: { x: 72, y: 39, z: 36 },
        rotation: { x: 0, y: 0, z: 0 },
        orientation,
        position: localToWorld(100, -46, 5),
      }),
      naturalVolume({
        // A second buried granite body spreads the load into the river-bank
        // terrain and destroys the hovering, single-contact silhouette of a
        // prop slab. Its whole visible surface is still the Boolean result.
        rockSeed: 4,
        topologyDetail: 20,
        scale: { x: 58, y: 34, z: 33 },
        rotation: { x: 0, y: 0, z: 0 },
        orientation,
        position: localToWorld(138, -58, 8),
      }),
      naturalVolume({
        // Broad overlapping natural plates break the camera-facing sheet into
        // metre-scale ledges. They intersect deeply enough to remain one CSG
        // body; none is a card, rail, or separately rendered prop.
        rockSeed: 2,
        topologyDetail: 30,
        scale: { x: 52, y: 19, z: 10 },
        rotation: { x: 0, y: 0, z: 0 },
        orientation,
        position: localToWorld(-55, 24, -27),
      }),
      naturalVolume({
        rockSeed: 4,
        topologyDetail: 30,
        scale: { x: 47, y: 17, z: 9 },
        rotation: { x: 0, y: 0, z: 0 },
        orientation,
        position: localToWorld(28, 1, -27),
      }),
      naturalVolume({
        // A third fractured leaf interrupts the formerly smooth raised end.
        // Its root overlaps the main mass and the portal cutters run after the
        // union, so it cannot refill or fake either opening.
        rockSeed: 6,
        topologyDetail: 30,
        scale: { x: 39, y: 14, z: 8 },
        rotation: { x: 0, y: 0, z: 0 },
        orientation,
        position: localToWorld(91, 31, -26),
      }),
    ],
  })
  mass.id = THRUST_MODIFIER_IDS[0]

  // These are shallow natural-rock subtractions, not planes, boxes or strip
  // geometry. Their irregular ends and chipped surfaces expose ledges in the
  // camera-facing side without sawing the sheet into disconnected plates.
  const partings = createBooleanVolumeModifier({
    operation: 'subtract',
    volumes: thrustPartingVolumes(),
  })
  partings.id = THRUST_MODIFIER_IDS[1]

  // Window cutters are elongated granite solids. Exact subtraction exposes
  // their natural joints as the lips and passage walls; no primitive or cube
  // participates in the hero formation.
  const windows = createBooleanVolumeModifier({
    operation: 'subtract',
    volumes: [...thrustWindowVolumes()],
  })
  windows.id = THRUST_MODIFIER_IDS[2]

  return [mass, partings, windows]
}

function thrustPartingVolumes(): CutterVolume[] {
  return [
    // One natural body chips the buried trailing perimeter. Crest cutters on
    // the thinner thrust sheet opened large black notches and destroyed the
    // continuous bedding silhouette; fracture there now comes from the union
    // operands' own joint planes instead of subtractive holes.
    { x: 111, y: -69, z: -13, sx: 26, sy: 19, sz: 17, seed: 1 },
  ].map((parting) => naturalVolume({
    rockSeed: parting.seed,
    topologyDetail: 20,
    scale: { x: parting.sx, y: parting.sy, z: parting.sz },
    rotation: { x: 0, y: 0, z: 0 },
    orientation,
    position: localToWorld(parting.x, parting.y, parting.z),
  }))
}

let cachedWindowVolumes: readonly CutterVolume[] | undefined

/**
 * The exact natural granite operands that cut the two portals.
 *
 * HeroShardGlow also derives its recessed ember backing from these meshes, so
 * the illuminated shape and the Boolean mouth can never drift into different
 * silhouettes. The returned volumes are treated as immutable.
 */
export function thrustWindowVolumes(): readonly CutterVolume[] {
  cachedWindowVolumes ??= WINDOWS.flatMap(windowVolumes)
  return cachedWindowVolumes
}

function windowVolumes(window: WindowShape): CutterVolume[] {
  const make = (
    detail: 20 | 30,
    xScale: number,
    yScale: number,
    zScale: number,
    localZ: number,
    interior: 'rock' | 'ember',
  ) => {
    const volume = naturalVolume({
      rockSeed: window.seed,
      topologyDetail: detail,
      scale: {
        x: window.rx * xScale,
        y: window.ry * yScale,
        z: zScale,
      },
      rotation: { x: 0, y: 0, z: 0 },
      orientation: windowOrientation,
      position: localToWorld(window.x, window.y, localZ),
    })
    // The Boolean backend transfers this classification to the newly exposed
    // cutter faces. Only the smaller, deeper body's terrain vertices become
    // the emitter; the wide mouth remains ordinary rock and therefore reveals
    // a real recessed sidewall instead of a silhouette-filling hot polygon.
    volume.interior = interior
    return volume
  }

  return [
    // A natural mouth body crosses only the camera-facing wall. Its fractured
    // end remains dark rock around the next body, giving the opening thickness
    // and an irregular annular ledge rather than filling it edge-to-edge.
    make(30, 1.3, 1.3, THRUST_DEPTH * 0.45, -THRUST_DEPTH * 0.2, 'rock'),
    // A second, smaller natural formation overlaps the mouth and continues
    // deeper into the mass. Its own blind rear shell is the actual emitter.
    // Because both operands are closed granite meshes, the step, sidewall and
    // cap are all exact terrain topology and remain valid from oblique views.
    make(30, 0.8, 0.84, THRUST_DEPTH * 0.34, THRUST_DEPTH * 0.04, 'ember'),
  ]
}

/**
 * The granite generator's planting frame is base-centred, while a CSG operand
 * needs its authored transform to describe the solid's actual centre. Recentre
 * the baked world-space bounds so extreme slab stretching cannot amplify a
 * harmless source-space x/z bias into a cutter that misses its own portal.
 */
function naturalVolume(options: Parameters<typeof graniteVolume>[0]) {
  const volume = graniteVolume(options)
  if (volume.kind !== 'mesh' || volume.positions.length === 0) return volume
  let centreX = 0
  let centreY = 0
  let centreZ = 0
  const vertexCount = volume.positions.length / 3
  for (let offset = 0; offset < volume.positions.length; offset += 3) {
    centreX += volume.positions[offset]
    centreY += volume.positions[offset + 1]
    centreZ += volume.positions[offset + 2]
  }
  centreX /= vertexCount
  centreY /= vertexCount
  centreZ /= vertexCount
  const dx = options.position.x - centreX
  const dy = options.position.y - centreY
  const dz = options.position.z - centreZ
  for (let offset = 0; offset < volume.positions.length; offset += 3) {
    volume.positions[offset] += dx
    volume.positions[offset + 1] += dy
    volume.positions[offset + 2] += dz
  }
  return volume
}

function localToWorld(x: number, y: number, z: number) {
  const point = new Vector3(x, y, z).applyMatrix4(formationMatrix)
  return { x: point.x, y: point.y, z: point.z }
}
