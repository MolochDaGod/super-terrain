import { hash2, positiveModulo } from '../../proceduralNoise'
import type { ColumnarFissureSample } from './columnarFissures'

interface BlockFeature {
  distance: number
  x: number
  y: number
  cellX: number
  cellY: number
}

/**
 * A periodic field of close, shallow bark blocks.
 *
 * Euclidean Voronoi cells make the familiar diagonal lozenges that read as
 * reptile scales on a trunk. Using a fourth-power distance keeps the useful
 * irregular topology while making the cell faces broad and their corners
 * softly rectangular. Boundary strength is stable per neighbouring pair, so
 * some shrinkage seams almost close instead of every block receiving the same
 * dark outline.
 */
export function sampleShallowBlocks(
  u: number,
  v: number,
  columns: number,
  rows: number,
  seed: number,
  transverseStrength = 0.42,
): ColumnarFissureSample {
  const countX = Math.max(2, Math.round(columns))
  const countY = Math.max(2, Math.round(rows))
  const x = u * countX + 4.9
  const y = v * countY - 3.7
  let nearest: BlockFeature | undefined
  let second: BlockFeature | undefined

  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    const sourceY = Math.floor(y) + offsetY
    const wrappedY = positiveModulo(sourceY, countY)
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const sourceX = Math.floor(x) + offsetX
      const wrappedX = positiveModulo(sourceX, countX)
      // Close to a grid, but never mechanically centred. Keeping the jitter
      // below a quarter cell prevents needle tips and giant neighbouring cells.
      const featureX = sourceX + 0.28 + hash2(wrappedX, wrappedY, seed + 17) * 0.44
      const featureY = sourceY + 0.25 + hash2(wrappedX, wrappedY, seed + 43) * 0.5
      const dx = Math.abs(featureX - x)
      const dy = Math.abs(featureY - y)
      const feature: BlockFeature = {
        distance: Math.pow(Math.pow(dx, 4) + Math.pow(dy, 4), 0.25),
        x: featureX,
        y: featureY,
        cellX: wrappedX,
        cellY: wrappedY,
      }
      if (!nearest || feature.distance < nearest.distance) {
        second = nearest
        nearest = feature
      } else if (!second || feature.distance < second.distance) {
        second = feature
      }
    }
  }

  const first = nearest!
  const other = second!
  const border = Math.max(0, (other.distance - first.distance) * 0.5)
  const dx = Math.abs(other.x - first.x)
  const dy = Math.abs(other.y - first.y)
  // The feature-to-feature vector is the boundary normal. Longitudinal seams
  // remain the clearest, but transverse seams never disappear: live-oak cork
  // is made of closed hand-scale blocks, not endless vertical ribbons.
  const longitudinal = dx / Math.max(1e-6, dx + dy)
  const orientation = transverseStrength + longitudinal * (1 - transverseStrength)
  const firstId = first.cellY * countX + first.cellX
  const otherId = other.cellY * countX + other.cellX
  const low = Math.min(firstId, otherId)
  const high = Math.max(firstId, otherId)
  const opening = 0.58 + hash2(low, high, seed + 79) * 0.34

  return {
    majorBorder: border,
    majorStrength: orientation * opening,
    crossBreakBorder: Number.POSITIVE_INFINITY,
    plateIdentity: hash2(first.cellX, first.cellY, seed + 97),
  }
}
