import { hash2, positiveModulo, smooth01 } from '../../proceduralNoise'

export interface PalmBootSample {
  majorBorder: number
  majorStrength: number
  crossBreakBorder: number
  plateIdentity: number
  /** Broad remnant of the severed petiole base, not merely its cut outline. */
  faceRelief: number
  /** Cell-scale weathering variation shared by relief and albedo grain. */
  faceTone: number
}

/**
 * Rhombic persistent leaf bases and the scars left when their petioles shed.
 *
 * A date-palm trunk is not vertically fissured wood. Successive phyllotactic
 * leaf bases overlap in staggered diagonal ranks, producing broad diamonds and
 * chevrons around the column. This periodic cell field encodes that anatomy
 * directly while jittering each row enough to avoid a machine-cut basket weave.
 */
export function samplePalmBoots(
  u: number,
  v: number,
  columns: number,
  rows: number,
  seed: number,
): PalmBootSample {
  const columnCount = Math.max(3, Math.round(columns))
  const rowCount = Math.max(4, Math.round(rows / 2) * 2)
  const y = v * rowCount
  const sourceRow = Math.floor(y)
  const row = positiveModulo(sourceRow, rowCount)
  const localY = y - sourceRow
  const stagger = (row % 2) * 0.5 +
    (hash2(row, 0, seed + 17) - 0.5) * 0.62
  const x = u * columnCount + stagger
  const sourceColumn = Math.floor(x)
  const column = positiveModulo(sourceColumn, columnCount)
  const localX = x - sourceColumn

  // The visible scar is principally the lower cut lip of an overlapping leaf
  // base, not a closed embossed lozenge. Stacked chevrons interlock into the
  // familiar diamond field while still reading as shorn, fibrous material.
  const identity = hash2(column, row, seed + 97)
  // A broad V is the silhouette of the severed petiole base. The previous
  // 0.25 slope displaced its corners by barely a tenth of a cell and baked as
  // an almost-horizontal blur once mipmapped onto the trunk.
  const shoulder = 0.78 + hash2(column, row, seed + 131) * 0.28
  const verticalShift = (hash2(column, row, seed + 173) - 0.5) * 0.16
  const lipY = 0.34 + verticalShift + Math.abs(localX - 0.5) * shoulder
  // Distances stay in cell units. The former sub-one multipliers made the
  // accepted band nearly half a row tall, producing a blurred rectangular
  // stain instead of the narrow hard cut edge of a shed petiole.
  const lip = Math.abs(localY - lipY)
  const majorBorder = lip
  const retention = hash2(column, row, seed + 211)
  const sideRetention = hash2(
    column * 2 + (localX < 0.5 ? 0 : 1),
    row,
    seed + 223,
  )
  // Neighbouring boot cells have different wear and vertical offsets. Letting
  // those fields jump at the cell boundary draws a perfectly straight dark
  // side wall around every scar. Fade the relief through a narrow torn edge so
  // each cut base ends as frayed fibre instead of a stamped rectangle.
  const edgeDistance = Math.min(localX, 1 - localX)
  const edgeAmount = Math.min(1, edgeDistance / 0.12)
  const tornEdge = edgeAmount * edgeAmount * (3 - 2 * edgeAmount)
  const faceCenterX = 0.5 + (hash2(column, row, seed + 269) - 0.5) * 0.14
  const faceCenterY = 0.49 + verticalShift * 0.42
  const faceHalfWidth = 0.43 + hash2(column, row, seed + 271) * 0.17
  const faceHalfHeight = 0.43 + hash2(column, row, seed + 277) * 0.24
  const skew = (localY - faceCenterY) * (hash2(column, row, seed + 281) - 0.5) * 0.3
  const diamondDistance = Math.abs(localX - faceCenterX + skew) / faceHalfWidth +
    Math.abs(localY - faceCenterY) / faceHalfHeight
  const erodedEdge = (hash2(
    sourceColumn * 7 + Math.floor(localX * 7),
    sourceRow * 9 + Math.floor(localY * 9),
    seed + 257,
  ) - 0.5) * 0.22
  const face = smooth01((1.04 - diamondDistance + erodedEdge) * 6.2)
  const faceWear = retention < 0.18 ? 0.18 + identity * 0.12 : 0.5 + identity * 0.5
  return {
    majorBorder,
    // Some bases weather nearly flush while neighbours retain a dark cut lip.
    // Without that attrition every row is a stamped decorative border.
    majorStrength: (retention < 0.5
      ? 0.018 + identity * 0.045
      : 0.16 + identity * 0.3) *
      (sideRetention < 0.22 ? 0.16 : 1) * tornEdge,
    crossBreakBorder: Number.POSITIVE_INFINITY,
    plateIdentity: identity,
    faceRelief: face * faceWear,
    faceTone: face * (0.36 + identity * 0.52) + (1 - face) * (0.12 + identity * 0.18),
  }
}
