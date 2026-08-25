import {
  add,
  cross,
  lerp,
  multiply,
  normalize,
  subtract,
  TreeRandom,
  vec3,
} from '../math'
import type { SemanticTreePart, TreeVec3 } from '../types'
import type { GrowthAxisSample } from './types'

export function samplePartPosition(part: SemanticTreePart, t: number): TreeVec3 {
  const scaled = Math.max(0, Math.min(1, t)) * (part.spine.length - 1)
  const index = Math.min(part.spine.length - 2, Math.floor(scaled))
  return lerp(
    part.spine[Math.max(0, index)]!.position,
    part.spine[Math.max(0, index + 1)]!.position,
    scaled - index,
  )
}

/** Sample a generated growth axis before it has been compiled into a tree part. */
export function sampleAxisPosition(
  samples: readonly GrowthAxisSample[],
  t: number,
): TreeVec3 {
  if (samples.length === 0) return vec3()
  if (samples.length === 1) return { ...samples[0]!.position }
  const scaled = Math.max(0, Math.min(1, t)) * (samples.length - 1)
  const index = Math.min(samples.length - 2, Math.floor(scaled))
  return lerp(
    samples[index]!.position,
    samples[index + 1]!.position,
    scaled - index,
  )
}

/** Local tangent at a normalized position along a generated growth axis. */
export function axisDirectionAt(
  samples: readonly GrowthAxisSample[],
  t: number,
): TreeVec3 {
  if (samples.length < 2) return vec3(0, 1, 0)
  const scaled = Math.max(0, Math.min(1, t)) * (samples.length - 1)
  const index = Math.min(samples.length - 2, Math.floor(scaled))
  return normalize(
    subtract(samples[index + 1]!.position, samples[index]!.position),
    vec3(0, 1, 0),
  )
}

export function sampledAxis(
  start: TreeVec3,
  direction: TreeVec3,
  length: number,
  startRadius: number,
  endRadius: number,
  random: TreeRandom,
  options: {
    samples?: number
    sag?: number
    rise?: number
    /** Optional tangent used only at the attachment, easing into direction. */
    startTangent?: TreeVec3
    /** Length of the attachment tangent relative to the axis length. */
    startTangentStrength?: number
    /** A gravity bow that is strongest halfway along and returns at the tip. */
    midSag?: number
    crook?: number
  } = {},
): GrowthAxisSample[] {
  const count = Math.max(4, options.samples ?? 8)
  const forward = normalize(direction, vec3(0, 1, 0))
  const reference = Math.abs(forward.y) < 0.86 ? vec3(0, 1, 0) : vec3(1, 0, 0)
  const side = normalize(cross(forward, reference), vec3(1, 0, 0))
  const startTangent = options.startTangent
    ? normalize(options.startTangent, forward)
    : undefined
  const startTangentStrength = options.startTangentStrength ?? 0.62
  const phase = random.range(0, Math.PI * 2)
  const samples: GrowthAxisSample[] = []
  for (let index = 0; index < count; index += 1) {
    const t = index / (count - 1)
    const curveEnvelope = startTangent
      ? Math.sin(t * Math.PI) ** 2
      : Math.sin(t * Math.PI)
    const bend = multiply(
      side,
      Math.sin(t * Math.PI * 1.4 + phase) * length * (options.crook ?? 0.025) *
        curveEnvelope,
    )
    const vertical = vec3(
      0,
      length * (
        (options.rise ?? 0) * t * t - (options.sag ?? 0) * t * t -
        (options.midSag ?? 0) * curveEnvelope
      ),
      0,
    )
    const base = startTangent
      ? hermiteDisplacement(
          startTangent,
          forward,
          length,
          startTangentStrength,
          t,
        )
      : multiply(forward, length * t)
    samples.push({
      position: add(start, add(base, add(bend, vertical))),
      radius: startRadius * Math.pow(endRadius / Math.max(1e-4, startRadius), t),
    })
  }
  return samples
}

/**
 * Cubic attachment path with a fixed endpoint and authored terminal bearing.
 * The start tangent lets an old lateral limb rise out of the bole before it
 * turns horizontal, instead of intersecting the trunk as a straight pipe.
 */
function hermiteDisplacement(
  startTangent: TreeVec3,
  endTangent: TreeVec3,
  length: number,
  startStrength: number,
  t: number,
): TreeVec3 {
  const t2 = t * t
  const t3 = t2 * t
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return add(
    multiply(startTangent, length * startStrength * h10),
    add(
      multiply(endTangent, length * h01),
      multiply(endTangent, length * h11),
    ),
  )
}

export function axisDirection(samples: readonly GrowthAxisSample[]): TreeVec3 {
  if (samples.length < 2) return vec3(0, 1, 0)
  return normalize(
    subtract(samples.at(-1)!.position, samples.at(-2)!.position),
    vec3(0, 1, 0),
  )
}
