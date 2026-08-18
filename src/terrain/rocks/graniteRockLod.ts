/** Screen-space LOD policy ported from scifi-kit's granite runtime. */

export type GraniteLodWeights = readonly [number, number, number]

const LOD1_FULL_DETAIL_PIXELS = 14
const LOD1_COARSE_PIXELS = 7
const LOD2_FULL_DETAIL_PIXELS = 8
const LOD2_COARSE_PIXELS = 4

export function drawableGraniteLodWeights(
  weights: GraniteLodWeights,
  cutoff = 0.002,
): GraniteLodWeights {
  const drawable = weights.map((weight) => weight > cutoff ? weight : 0)
  const total = drawable[0]! + drawable[1]! + drawable[2]!
  if (total <= 0) return [1, 0, 0]
  return [
    drawable[0]! / total,
    drawable[1]! / total,
    drawable[2]! / total,
  ]
}

export function projectedGraniteErrorPixels(
  errorWorld: number,
  distance: number,
  verticalFovDegrees: number,
  viewportHeight: number,
): number {
  const safeDistance = Math.max(1e-4, distance)
  const fovRadians = verticalFovDegrees * Math.PI / 180
  return errorWorld * viewportHeight /
    (2 * Math.tan(fovRadians * 0.5) * safeDistance)
}

export function targetGraniteLodWeights(
  lod1ErrorPixels: number,
  lod2ErrorPixels: number,
  minimumLevel: 0 | 1 | 2 = 0,
): GraniteLodWeights {
  const lod1 = minimumLevel >= 1
    ? 1
    : 1 - smoothstep(
      LOD1_COARSE_PIXELS,
      LOD1_FULL_DETAIL_PIXELS,
      lod1ErrorPixels,
    )
  const lod2 = minimumLevel >= 2
    ? 1
    : 1 - smoothstep(
      LOD2_COARSE_PIXELS,
      LOD2_FULL_DETAIL_PIXELS,
      lod2ErrorPixels,
    )
  const level2 = lod1 * lod2
  return [1 - lod1, lod1 - level2, level2]
}

export function settleGraniteLodWeights(
  current: GraniteLodWeights,
  target: GraniteLodWeights,
  deltaSeconds: number,
  response = 12,
): GraniteLodWeights {
  const blend = 1 - Math.exp(-Math.max(0, deltaSeconds) * response)
  const next = current.map(
    (value, index) => value + (target[index]! - value) * blend,
  )
  const total = next[0]! + next[1]! + next[2]! || 1
  return [next[0]! / total, next[1]! / total, next[2]! / total]
}

export function graniteLodWeightsForLevel(
  level: 0 | 1 | 2,
): GraniteLodWeights {
  return level === 0 ? [1, 0, 0] : level === 1 ? [0, 1, 0] : [0, 0, 1]
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}
