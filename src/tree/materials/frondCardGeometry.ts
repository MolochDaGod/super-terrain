import { BufferAttribute, BufferGeometry } from 'three/webgpu'

/** Cheap deterministic variation; geometry variants must match in export. */
function variation(variant: number, station: number, salt: number): number {
  const value = Math.sin(
    variant * 91.731 + station * 17.173 + salt * 43.117,
  ) * 43758.5453
  return value - Math.floor(value)
}

function rachisArch(v: number, variant: number): number {
  if (variant < 2) return Math.sin(v * Math.PI) * 0.038 - v * v * 0.035
  const age = variant < 10 ? 0 : Math.min(1, (variant - 9) / 6)
  const arch = 0.07 + variation(variant, 0, 19) * 0.11
  const droop = 0.13 + variation(variant, 0, 23) * 0.24 + age * 0.13
  // The second term moves the point of maximum curvature between variants;
  // otherwise every leaf is visibly the same parabola after instancing.
  const shoulder = Math.sin(Math.pow(v, 0.76 + variation(variant, 0, 21) * 0.38) * Math.PI)
  return shoulder * arch - Math.pow(v, 1.72) * droop
}

function rachisSway(v: number, variant: number): number {
  const phase = variation(variant, 0, 29) * Math.PI * 2
  const primary = Math.sin(v * Math.PI * 1.2 + phase) * Math.sin(v * Math.PI)
  const tipHook = Math.sin(v * Math.PI * 0.62) * (variation(variant, 0, 37) - 0.5)
  return (primary + tipHook * 0.7) *
    (variant < 2 ? 0.01 : 0.027 + variation(variant, 0, 31) * 0.043)
}

function stationAttachment(
  nominal: number,
  variant: number,
  station: number,
  sideSalt: number,
): number {
  // Date-palm pinnae emerge in small ranks and irregular groups rather than in
  // the perfect opposed zipper made by evenly spaced bilateral stations.
  const grouped = nominal + Math.sin(nominal * Math.PI * 11 + variant * 1.7) * 0.014
  return Math.min(0.982, Math.max(0.11,
    0.135 + grouped * 0.835 +
    (variation(variant, station, sideSalt) - 0.5) * 0.038,
  ))
}

/**
 * An actual compound palm leaf, not a photograph of one on a quad.
 *
 * Whole-frond alpha cards always collapse to a black line from at least one
 * common view and reveal a rectangular/fishbone plane at close range. This
 * mesh keeps the instancing economy but gives every pinna its own tapered
 * surface in the rachis V. Eight deterministic variants vary loss, roll and
 * length without adding per-tree geometry allocations.
 */
export function createFrondCardGeometry(variant = 0): BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  const vertex = (
    x: number,
    y: number,
    z: number,
    red: number,
    green: number,
    blue: number,
    u: number,
    v: number,
  ) => {
    positions.push(x, y, z)
    colors.push(red, green, blue)
    uvs.push(u, v)
    return positions.length / 3 - 1
  }

  // A narrow, segmented rachis ribbon catches light independently of the
  // pinnae and closes the otherwise conspicuous transparent line down the leaf.
  const rachisRows = 18
  for (let row = 0; row <= rachisRows; row += 1) {
    const v = row / rachisRows
    // Expanding centre leaves are still folded into a narrow pleated spear.
    // Rendering miniature pinnae on them produced two little fir trees in the
    // crown centre; a broader folded rachis is the visible organ at this age.
    const halfWidth = (variant < 2 ? 0.027 + variant * 0.014 : 0.0095) *
      (1 - v * (variant < 2 ? 0.76 : 0.58))
    const z = rachisArch(v, variant)
    const centerX = rachisSway(v, variant)
    vertex(centerX - halfWidth, v, z, 0.11, 0.23, 0.055, 0, v)
    vertex(centerX + halfWidth, v, z, 0.14, 0.27, 0.065, 1, v)
  }
  for (let row = 0; row < rachisRows; row += 1) {
    const corner = row * 2
    indices.push(corner, corner + 1, corner + 3, corner, corner + 3, corner + 2)
  }
  if (variant < 2) {
    const foldedStart = positions.length / 3
    for (let row = 0; row <= rachisRows; row += 1) {
      const v = row / rachisRows
      const halfWidth = (0.027 + variant * 0.014) * (1 - v * 0.76) * 0.78
      const z = rachisArch(v, variant)
      const centerX = rachisSway(v, variant)
      vertex(centerX, v, z - halfWidth, 0.095, 0.22, 0.047, 0, v)
      vertex(centerX, v, z + halfWidth, 0.14, 0.29, 0.06, 1, v)
    }
    for (let row = 0; row < rachisRows; row += 1) {
      const corner = foldedStart + row * 2
      indices.push(corner, corner + 1, corner + 3, corner, corner + 3, corner + 2)
    }
  }

  const development = variant < 2 ? 0.08 + variant * 0.2 : 1
  const age = variant < 10 ? 0 : Math.min(1, (variant - 9) / 6)
  const stationCount = variant < 2
    ? 0
    : 52 + Math.round(variation(variant, 0, 41) * 17)
  const damageCenter = 0.3 + variation(variant, 0, 43) * 0.58
  const damageWidth = 0.035 + variation(variant, 0, 47) * 0.09
  for (let station = 0; station < stationCount; station += 1) {
    const nominal = station / Math.max(1, stationCount - 1)
    for (const side of [-1, 1] as const) {
      const sideSalt = side < 0 ? 3 : 7
      const v = stationAttachment(nominal, variant, station, sideSalt)
      const taper = Math.pow(Math.sin(Math.pow(v, 0.72) * Math.PI), 0.5)
      const inDamagePatch = Math.abs(v - damageCenter) < damageWidth
      const lossChance = 0.025 + age * 0.11 + (inDamagePatch ? 0.1 + age * 0.32 : 0)
      if (station > 2 && variation(variant, station, sideSalt + 11) < lossChance) continue

      const shortened = variation(variant, station, sideSalt + 1) < 0.07 + age * 0.16
      const reach = taper * (0.315 + variation(variant, station, sideSalt + 2) * 0.205) *
        (0.12 + development * 0.88) *
        (shortened ? 0.38 + variation(variant, station, sideSalt + 3) * 0.38 : 1)
      const sweep = (variation(variant, station, sideSalt + 4) - 0.5) * 0.035
      const baseX = rachisSway(v, variant)
      // Phoenix pinnae occupy several ranks around the rachis. Rotating every
      // blade into one common plane made a clean bilateral zipper no matter
      // how much its outline was jittered. Keep small groups in a shared rank,
      // then change rank at irregular three-to-five-pinna intervals.
      const groupSpan = 3 + Math.floor(variation(variant, 0, sideSalt + 29) * 3)
      const group = Math.floor(station / groupSpan)
      const rankAngle = (variation(variant, group, sideSalt + 31) - 0.5) * 0.76 +
        (variation(variant, station, sideSalt + 37) - 0.5) * 0.11
      const tipX = baseX + side * reach * Math.cos(rankAngle) +
        (variation(variant, station, sideSalt + 13) - 0.5) * reach * 0.035
      const rake = (0.115 * (1 - v) - 0.052 * v) * taper + sweep
      const tipY = Math.min(0.997, v + rake +
        (variation(variant, station, sideSalt + 5) - 0.5) * 0.022)
      const baseArch = rachisArch(v, variant)
      // Each pinna owns a different insertion angle and tip sag. This produces
      // the shaggy three-dimensional feather of a real Phoenix leaf instead of
      // two planar ranks whose silhouettes merge into a saw blade.
      const insertion = (variation(variant, station, sideSalt + 6) - 0.5) * 0.045
      const fold = -reach * (0.1 + Math.sin(v * Math.PI) * 0.13 + age * 0.08)
      const tipSag = Math.pow(reach, 1.35) * (0.05 + variation(variant, station, sideSalt + 8) * 0.13)
      const tipZ = baseArch + fold + Math.sin(rankAngle) * reach + side * insertion - tipSag
      const dx = tipX - baseX
      const dy = tipY - v
      const inverse = 1 / Math.max(1e-4, Math.hypot(dx, dy))
      const perpendicularX = -dy * inverse
      const perpendicularY = dx * inverse
      const rootWidth = 0.0024
      const bladeWidth = 0.0028 + taper * 0.0035 *
        (0.82 + variation(variant, station, sideSalt + 9) * 0.36)
      // Three longitudinal rails make a real folded pinna: two blade halves
      // meet at a raised midrib and therefore carry different normals. The old
      // boundary fan was geometrically one paper sheet even though its outline
      // was leaf-shaped, which is why every leaflet lit as a flat card.
      const bladeCup = reach * (0.014 + variation(variant, station, sideSalt + 10) * 0.028)
      const bladeTwist = (variation(variant, station, sideSalt + 19) - 0.5) *
        bladeWidth * 0.8
      const tone = 0.76 + variation(variant, station, sideSalt + 12) * 0.31
      const sunFade = 0.92 + v * 0.1
      const start = positions.length / 3
      const bladeRows = [0, 0.18, 0.52, 0.82, 1] as const
      const widths = [rootWidth, bladeWidth, bladeWidth * 0.94, bladeWidth * 0.7, 0]
      for (const [rowIndex, bladeT] of bladeRows.entries()) {
        const centerX = baseX + dx * bladeT
        const centerY = v + dy * bladeT
        const cupShape = Math.sin(bladeT * Math.PI)
        const centerZ = baseArch + (tipZ - baseArch) * bladeT + bladeCup * cupShape * 0.16
        const width = widths[rowIndex]!
        const twist = bladeTwist * Math.sin(bladeT * Math.PI)
        const edgeZ = centerZ - bladeCup * cupShape * 0.56
        const fade = 1 + (sunFade - 1) * bladeT
        vertex(
          centerX + perpendicularX * width,
          centerY + perpendicularY * width,
          edgeZ + twist,
          0.13 * tone * fade,
          0.3 * tone * fade,
          0.065 * tone * fade,
          0,
          bladeT,
        )
        vertex(
          centerX,
          centerY,
          centerZ,
          0.135 * tone * fade,
          0.31 * tone * fade,
          0.067 * tone * fade,
          0.5,
          bladeT,
        )
        vertex(
          centerX - perpendicularX * width,
          centerY - perpendicularY * width,
          edgeZ - twist,
          0.105 * tone * fade,
          0.255 * tone * fade,
          0.05 * tone * fade,
          1,
          bladeT,
        )
      }
      for (let bladeRow = 0; bladeRow < bladeRows.length - 1; bladeRow += 1) {
        const row = start + bladeRow * 3
        const next = row + 3
        indices.push(
          row, row + 1, next + 1,
          row, next + 1, next,
          row + 1, row + 2, next + 2,
          row + 1, next + 2, next + 1,
        )
      }
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
