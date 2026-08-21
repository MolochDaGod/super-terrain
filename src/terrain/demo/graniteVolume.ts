import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { generateGraniteRock } from '../rocks/generateGraniteRock'
import type { GraniteTopologyDetail } from '../rocks/types'
import type { CutterVolume } from '../modifiers/boolean/CutterVolume'
import type { TerrainApron } from '../modifiers/boolean/CutterVolume'
import type { Vec3Like } from '../core/types'

export interface GraniteVolumeOptions {
  rockSeed: number
  topologyDetail: GraniteTopologyDetail
  scale: Vec3Like
  rotation: Vec3Like
  /** Overrides `rotation` when the orientation is derived rather than authored. */
  orientation?: Quaternion
  position: Vec3Like
  /** Optional terrain-side transition retained with this CSG operand. */
  terrainApron?: TerrainApron
}

interface Blank {
  positions: Float32Array | number[]
  indices: ArrayLike<number>
  centreY: number
  halfHeight: number
}

/**
 * Generating one granite topology costs about a tenth of a second, and the demo
 * plants dozens of them. They are only ever used as CSG operands — scaled,
 * rotated and buried differently each time — so the source solid is generated
 * once per seed and the transform is what makes each placement distinct.
 */
const blanks = new Map<string, Blank>()

function graniteBlank(seed: number, detail: GraniteTopologyDetail): Blank {
  const key = `${seed}:${detail}`
  const cached = blanks.get(key)
  if (cached) return cached

  const mesh = generateGraniteRock({
    seed,
    surfaceSeed: seed,
    placementScale: 1,
    snow: 0,
    wetness: 0,
    lichen: 0,
    moss: 0,
    detailStrength: 1,
    detail: 3,
    topologyDetail: detail,
  })
  // Local bounds, so the solid is centred on its own body before it is scaled:
  // the generator plants rocks with y = 0 at the base.
  let minY = Infinity
  let maxY = -Infinity
  for (let offset = 1; offset < mesh.positions.length; offset += 3) {
    minY = Math.min(minY, mesh.positions[offset])
    maxY = Math.max(maxY, mesh.positions[offset])
  }
  const blank: Blank = {
    positions: mesh.positions,
    indices: mesh.indices,
    centreY: (minY + maxY) * 0.5,
    halfHeight: Math.max(0.001, (maxY - minY) * 0.5),
  }
  blanks.set(key, blank)
  return blank
}

/**
 * One granite topology, baked into world space as a CSG mesh operand.
 *
 * The rock generator returns a closed, consistently wound two-manifold in a
 * local frame whose origin sits on the planting plane. Baking the transform
 * here rather than carrying it on the modifier keeps the operand exactly what
 * the Boolean backend wants: world-space triangles, no matrix to agree about
 * between two sections that both cut the same formation.
 */
export function graniteVolume(options: GraniteVolumeOptions): CutterVolume {
  const blank = graniteBlank(options.rockSeed, options.topologyDetail)

  const matrix = new Matrix4().compose(
    new Vector3(options.position.x, options.position.y, options.position.z),
    options.orientation ??
      new Quaternion().setFromEuler(
        new Euler(options.rotation.x, options.rotation.y, options.rotation.z, 'YXZ'),
      ),
    // Normalised on the solid's own half-height so the requested scale is in
    // metres of finished rock rather than in the generator's arbitrary units.
    new Vector3(
      options.scale.x / blank.halfHeight,
      options.scale.y / blank.halfHeight,
      options.scale.z / blank.halfHeight,
    ),
  )

  const point = new Vector3()
  const positions: number[] = new Array(blank.positions.length)
  for (let offset = 0; offset < blank.positions.length; offset += 3) {
    point
      .set(
        blank.positions[offset],
        blank.positions[offset + 1] - blank.centreY,
        blank.positions[offset + 2],
      )
      .applyMatrix4(matrix)
    positions[offset] = point.x
    positions[offset + 1] = point.y
    positions[offset + 2] = point.z
  }

  return {
    kind: 'mesh',
    positions,
    indices: Array.from(blank.indices),
    terrainApron: options.terrainApron
      ? {
          ...options.terrainApron,
          center: { ...options.terrainApron.center },
          forward: { ...options.terrainApron.forward },
        }
      : undefined,
  }
}
