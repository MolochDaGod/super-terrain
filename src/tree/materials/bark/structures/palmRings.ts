import { hash2, positiveModulo, smooth01 } from '../../proceduralNoise'
import type { PalmBootSample } from './palmBoots'

/**
 * Broken annular leaf scars on a coconut stipe.
 *
 * The scar is a growth ring assembled from weathered arc segments, not a
 * continuous lathed groove. Returning the shared palm-surface sample keeps
 * albedo, normal and roughness derived from exactly the same anatomy.
 */
export function samplePalmRings(
  u: number,
  v: number,
  segments: number,
  rows: number,
  seed: number,
): PalmBootSample {
  const segmentCount = Math.max(7, Math.round(segments))
  const rowCount = Math.max(8, Math.round(rows))
  const y = v * rowCount
  const sourceRow = Math.floor(y)
  const row = positiveModulo(sourceRow, rowCount)
  const localY = y - sourceRow
  const x = u * segmentCount
  const sourceSegment = Math.floor(x)
  const segment = positiveModulo(sourceSegment, segmentCount)
  const localX = x - sourceSegment
  const identity = hash2(segment, row, seed + 97)
  const neighbour = hash2(segment + 1, row, seed + 131)
  const arcWarp = (identity - 0.5) * 0.14 +
    Math.sin(localX * Math.PI) * (neighbour - 0.5) * 0.08
  const lipY = 0.48 + arcWarp
  const majorBorder = Math.abs(localY - lipY)
  const edge = Math.min(1, Math.min(localX, 1 - localX) / 0.09)
  const tornEdge = edge * edge * (3 - 2 * edge)
  const missing = hash2(segment, row, seed + 173)
  const majorStrength = (missing < 0.16 ? 0.04 : 0.48 + identity * 0.34) * tornEdge
  const shoulder = smooth01((localY - lipY + 0.18) * 5.5) *
    smooth01((lipY + 0.06 - localY) * 8)
  return {
    majorBorder,
    majorStrength,
    crossBreakBorder: Number.POSITIVE_INFINITY,
    plateIdentity: identity,
    faceRelief: shoulder * (0.28 + identity * 0.32),
    faceTone: 0.18 + shoulder * (0.18 + identity * 0.22),
  }
}
