import { BufferAttribute, BufferGeometry } from 'three/webgpu'

function variation(variant: number, leaf: number, salt: number): number {
  const value = Math.sin(variant * 83.173 + leaf * 23.717 + salt * 47.311) * 43758.5453
  return value - Math.floor(value)
}

/** A complete three-dimensional terminal rosette of folded succulent leaves. */
export function createSucculentRosetteGeometry(variant = 0): BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const rows = [0, 0.14, 0.34, 0.58, 0.8, 1] as const
  const leafCount = 32 + Math.floor(variation(variant, 0, 3) * 9)

  const vertex = (
    x: number, y: number, z: number,
    red: number, green: number, blue: number,
    u: number, v: number,
  ) => {
    positions.push(x, y, z)
    colors.push(red, green, blue)
    uvs.push(u, v)
    return positions.length / 3 - 1
  }

  for (let leaf = 0; leaf < leafCount; leaf += 1) {
    const age = leaf / Math.max(1, leafCount - 1)
    const azimuth = leaf * Math.PI * (3 - Math.sqrt(5)) +
      (variation(variant, leaf, 7) - 0.5) * 0.16
    const radialX = Math.cos(azimuth)
    const radialZ = Math.sin(azimuth)
    const tangentX = -radialZ
    const tangentZ = radialX
    // Length peaks on the mature ring: the newest leaves are still expanding
    // and the oldest have shortened and dried back.
    const length = (0.34 + Math.sin(Math.min(1, age * 1.35) * Math.PI) * 0.72) *
      (0.9 + variation(variant, leaf, 11) * 0.18)
    // A rosette is a shuttlecock, not a disc. Every leaf leaves the apex
    // steeply and arches over; only the oldest outer ring finishes below the
    // horizontal. Reading the lift straight off the leaf index put almost the
    // whole rosette flat, which is what made these render as pinwheels.
    const climb = 2.1 - Math.pow(age, 0.8) * 1.85 +
      (variation(variant, leaf, 29) - 0.5) * 0.22
    const droop = 0.5 + Math.pow(age, 1.4) * 2.35
    const width = (0.05 + age * 0.03) *
      (0.86 + variation(variant, leaf, 17) * 0.24)
    const roll = (variation(variant, leaf, 31) - 0.5) * 0.5
    const tone = (0.8 + variation(variant, leaf, 19) * 0.26) *
      // Dry back at the very oldest ring, the way a retained skirt does.
      (age > 0.88 ? 0.82 : 1)
    const start = positions.length / 3

    for (const t of rows) {
      // The leaf is an arc, not a ray: it climbs on `climb` and is pulled back
      // by `droop`, so the whole rosette has a curved profile at every ring.
      const reach = length * t
      const centerX = radialX * reach
      const centerZ = radialZ * reach
      const centerY = length * (climb * t - droop * t * t) * 0.5
      // Strap leaves taper to a point and are widest a third of the way out.
      const taper = Math.sin(Math.pow(t, 0.72) * Math.PI)
      const envelope = taper * width
      // Keel: the leaf is folded along its midrib, deepest near the base.
      const cup = taper * width * (0.75 - t * 0.3)
      const twist = roll * t * width
      const fade = 0.9 + t * 0.1
      vertex(
        centerX + tangentX * envelope,
        centerY - cup + twist,
        centerZ + tangentZ * envelope,
        0.18 * tone * fade,
        0.29 * tone * fade,
        0.19 * tone * fade,
        0,
        t,
      )
      vertex(
        centerX,
        centerY + cup * 0.24,
        centerZ,
        0.23 * tone * fade,
        0.36 * tone * fade,
        0.235 * tone * fade,
        0.5,
        t,
      )
      vertex(
        centerX - tangentX * envelope,
        centerY - cup - twist,
        centerZ - tangentZ * envelope,
        0.15 * tone * fade,
        0.25 * tone * fade,
        0.16 * tone * fade,
        1,
        t,
      )
    }

    for (let row = 0; row < rows.length - 1; row += 1) {
      const current = start + row * 3
      const next = current + 3
      indices.push(
        current, current + 1, next + 1,
        current, next + 1, next,
        current + 1, current + 2, next + 2,
        current + 1, next + 2, next + 1,
      )
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(Float32Array.from(colors), 3))
  geometry.setAttribute('uv', new BufferAttribute(Float32Array.from(uvs), 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}
