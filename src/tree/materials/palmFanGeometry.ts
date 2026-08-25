import { BufferAttribute, BufferGeometry } from 'three/webgpu'

function variation(variant: number, blade: number, salt: number): number {
  const value = Math.sin(variant * 73.913 + blade * 19.171 + salt * 41.737) * 43758.5453
  return value - Math.floor(value)
}

/**
 * Pleated costapalmate leaf used by Hyphaene (doum) palms.
 *
 * Doum leaves are fans, not pinnate feather leaves.  Each radial blade is an
 * independent folded strip so the distal splits stay legible in silhouette
 * and the fan catches alternating bands of light instead of reading as one
 * translucent polygon.
 */
export function createPalmFanGeometry(variant = 0): BufferGeometry {
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

  // A thick, slightly keeled petiole occupies the lower third of the organ.
  const petioleRows = 8
  for (let row = 0; row <= petioleRows; row += 1) {
    const t = row / petioleRows
    const y = t * 0.36
    const centerX = Math.sin(t * Math.PI) * (variation(variant, 0, 3) - 0.5) * 0.026
    const centerZ = Math.sin(t * Math.PI) * 0.018 - t * t * 0.025
    const width = 0.013 + t * 0.022
    vertex(centerX - width, y, centerZ, 0.22, 0.31, 0.09, 0, t)
    vertex(centerX + width, y, centerZ, 0.25, 0.35, 0.105, 1, t)
  }
  for (let row = 0; row < petioleRows; row += 1) {
    const corner = row * 2
    indices.push(corner, corner + 1, corner + 3, corner, corner + 3, corner + 2)
  }

  const bladeCount = 19 + Math.floor(variation(variant, 0, 7) * 4)
  const age = variant < 10 ? 0 : Math.min(1, (variant - 9) / 6)
  const phase = (variation(variant, 0, 11) - 0.5) * 0.06
  const rows = [0.035, 0.24, 0.52, 0.78, 1] as const
  let previousBladeStart: number | undefined

  for (let blade = 0; blade < bladeCount; blade += 1) {
    const across = blade / Math.max(1, bladeCount - 1)
    const angle = -1.08 + across * 2.16 + phase +
      (variation(variant, blade, 13) - 0.5) * 0.045
    const central = Math.pow(Math.sin(across * Math.PI), 0.32)
    const lost = age > 0.18 && blade > 0 && blade < bladeCount - 1 &&
      variation(variant, blade, 17) < age * 0.12
    if (lost) continue

    const reach = (0.53 + central * 0.17) *
      (0.91 + variation(variant, blade, 19) * 0.13) *
      (variation(variant, blade, 23) < age * 0.18 ? 0.5 : 1)
    const directionX = Math.sin(angle)
    const directionY = Math.cos(angle)
    const perpendicularX = -directionY
    const perpendicularY = directionX
    const baseX = (variation(variant, blade, 29) - 0.5) * 0.012
    const baseY = 0.345 + central * 0.018
    const foldSign = blade % 2 === 0 ? -1 : 1
    const fold = foldSign * (0.018 + variation(variant, blade, 31) * 0.026)
    const bladeWidth = 0.021 + central * 0.012
    const tone = 0.78 + variation(variant, blade, 37) * 0.28
    const start = positions.length / 3

    for (const [rowIndex, t] of rows.entries()) {
      // Separating only the outer half forms the characteristic torn fan while
      // retaining a continuous pleated costa around the attachment.
      const split = Math.pow(t, 1.45)
      const centerX = baseX + directionX * reach * t
      const centerY = baseY + directionY * reach * t - Math.pow(t, 2.15) * 0.035
      const centerZ = Math.sin(t * Math.PI) * fold - Math.pow(t, 2) * 0.055
      const widthEnvelope = Math.sin(t * Math.PI) * bladeWidth * (0.42 + split * 0.58)
      const tipFray = rowIndex === rows.length - 1
        ? (variation(variant, blade, 41) - 0.5) * 0.018
        : 0
      const edgeZ = centerZ - Math.sin(t * Math.PI) * Math.abs(fold) * 0.72
      vertex(
        centerX + perpendicularX * widthEnvelope,
        centerY + perpendicularY * widthEnvelope + tipFray,
        edgeZ,
        0.13 * tone,
        0.31 * tone,
        0.055 * tone,
        0,
        t,
      )
      vertex(
        centerX,
        centerY + tipFray,
        centerZ,
        0.16 * tone,
        0.36 * tone,
        0.067 * tone,
        0.5,
        t,
      )
      vertex(
        centerX - perpendicularX * widthEnvelope,
        centerY - perpendicularY * widthEnvelope + tipFray,
        edgeZ,
        0.11 * tone,
        0.27 * tone,
        0.047 * tone,
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

    if (previousBladeStart !== undefined) {
      // The basal half of a costapalmate leaf is one pleated blade. Only the
      // distal half splits into free segments. Bridging adjacent folds through
      // the first three rows removes the sea-urchin array while preserving the
      // ragged fan perimeter and alternating normals.
      for (let row = 0; row < 2; row += 1) {
        const previous = previousBladeStart + row * 3 + 2
        const previousNext = previousBladeStart + (row + 1) * 3 + 2
        const current = start + row * 3
        const currentNext = start + (row + 1) * 3
        indices.push(previous, current, currentNext, previous, currentNext, previousNext)
      }
    }
    previousBladeStart = start
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
