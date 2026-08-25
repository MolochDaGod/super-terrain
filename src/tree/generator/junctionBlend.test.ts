import { describe, expect, it } from 'vitest'
import {
  junctionNeighbourhood,
  junctionSwell,
  roundConeDistance,
  type BlendSegment,
} from './junctionBlend'
import { vec3 } from './math'
import type { SemanticTreePart, TreeSpineSample } from './types'

function segment(
  start: [number, number, number],
  end: [number, number, number],
  startRadius: number,
  endRadius = startRadius,
): BlendSegment {
  return {
    start: vec3(...start),
    end: vec3(...end),
    startRadius,
    endRadius,
  }
}

function spine(
  points: readonly [number, number, number][],
  radii: readonly number[],
): TreeSpineSample[] {
  return points.map((point, index) => ({
    position: vec3(...point),
    radius: radii[index]!,
    burialDepth: 0,
    crossSection: {
      radiusX: radii[index]!,
      radiusZ: radii[index]!,
      rotation: 0,
      lobeCount: 1,
      lobeStrength: 0,
    },
  }))
}

function part(
  overrides: Partial<SemanticTreePart> & Pick<SemanticTreePart, 'id' | 'spine'>,
): SemanticTreePart {
  return {
    type: 'branch',
    children: [],
    branchOrder: 1,
    age: 0.5,
    vigor: 1,
    dominance: 1,
    attachment: 1,
    junctionType: 'lateral',
    ...overrides,
  }
}

describe('round cone distance', () => {
  it('measures a cylinder flank, both caps, and the interior', () => {
    const trunk = segment([0, 0, 0], [0, 4, 0], 1)
    expect(roundConeDistance(vec3(3, 2, 0), trunk)).toBeCloseTo(2, 6)
    expect(roundConeDistance(vec3(0, 2, 0), trunk)).toBeCloseTo(-1, 6)
    expect(roundConeDistance(vec3(0, 6, 0), trunk)).toBeCloseTo(1, 6)
    expect(roundConeDistance(vec3(0, -3, 0), trunk)).toBeCloseTo(2, 6)
  })

  it('follows the tangent flank of a taper rather than a lerped radius', () => {
    const taper = segment([0, 0, 0], [0, 4, 0], 2, 0)
    // The true surface is the tangent line between the two spheres, which lies
    // inside the naive lerp everywhere along the flank.
    const naive = 2 - (2 * 2) / 4
    expect(roundConeDistance(vec3(naive, 2, 0), taper)).toBeLessThan(-0.01)
    // The apex sphere has zero radius, so the tip is exactly on the surface.
    expect(roundConeDistance(vec3(0, 4, 0), taper)).toBeCloseTo(0, 6)
  })
})

describe('junction swell', () => {
  const neighbourhood = {
    segments: [segment([0, 0, 0], [0, 4, 0], 1)],
    blendRadius: 0.5,
    maximumSwell: 1,
  }

  it('is zero well outside the fillet radius', () => {
    expect(junctionSwell(vec3(4, 2, 0), neighbourhood, 0.5)).toBe(0)
  })

  it('peaks on the intersection curve and decays outward', () => {
    const onSurface = junctionSwell(vec3(1, 2, 0), neighbourhood, 0.5)
    const nearby = junctionSwell(vec3(1.2, 2, 0), neighbourhood, 0.5)
    expect(onSurface).toBeGreaterThan(0.05)
    expect(nearby).toBeGreaterThan(0)
    expect(nearby).toBeLessThan(onSurface)
  })

  it('keeps climbing on the buried side so the visible crease is never a peak', () => {
    const outside = junctionSwell(vec3(1.05, 2, 0), neighbourhood, 0.5)
    const crease = junctionSwell(vec3(1, 2, 0), neighbourhood, 0.5)
    const buried = junctionSwell(vec3(0.9, 2, 0), neighbourhood, 0.5)
    expect(buried).toBeGreaterThan(crease)
    expect(crease).toBeGreaterThan(outside)
  })

  it('never exceeds the ceiling, however deeply a vertex is embedded', () => {
    expect(junctionSwell(vec3(0, 2, 0), neighbourhood, 0.5))
      .toBeLessThanOrEqual(neighbourhood.maximumSwell)
  })

  it('scales the bead by the thinner member, not by the parent', () => {
    const bole = {
      segments: [segment([0, 0, 0], [0, 8, 0], 3)],
      blendRadius: 3,
      maximumSwell: 3,
    }
    const twig = junctionSwell(vec3(3, 4, 0), bole, 0.05)
    const limb = junctionSwell(vec3(3, 4, 0), bole, 2)
    expect(twig).toBeLessThan(0.1)
    expect(limb).toBeGreaterThan(twig * 5)
  })

  it('returns zero without a neighbourhood', () => {
    expect(junctionSwell(vec3(1, 2, 0), undefined, 0.5)).toBe(0)
  })
})

describe('junction neighbourhood', () => {
  const trunk = part({
    id: 'trunk',
    type: 'trunk',
    branchOrder: 0,
    children: ['limb', 'far'],
    spine: spine(
      [[0, 0, 0], [0, 4, 0], [0, 8, 0], [0, 12, 0]],
      [1.4, 1.2, 1, 0.8],
    ),
  })
  const limb = part({
    id: 'limb',
    parentId: 'trunk',
    attachment: 0.66,
    spine: spine([[0, 8, 0], [4, 10, 0], [8, 11, 0]], [0.6, 0.4, 0.2]),
  })
  const far = part({
    id: 'far',
    parentId: 'trunk',
    attachment: 0.08,
    spine: spine([[0, 1, 0], [3, 2, 0]], [0.3, 0.15]),
  })
  const byId = new Map([trunk, limb, far].map((entry) => [entry.id, entry]))

  it('gives a child the parent span around its own attachment only', () => {
    const local = junctionNeighbourhood(limb, byId)!
    expect(local.segments.length).toBeGreaterThan(0)
    // Every segment must lie within reach of the union at y = 8.
    for (const piece of local.segments) {
      expect(Math.min(piece.start.y, piece.end.y)).toBeGreaterThan(1)
    }
  })

  it('gives a parent only the emerging stretch of each child', () => {
    const local = junctionNeighbourhood(trunk, byId)!
    const reach = Math.max(...local.segments.map((piece) =>
      Math.hypot(piece.end.x, piece.end.z)))
    expect(local.segments.length).toBeGreaterThan(0)
    // The limb runs out to x = 8; only its base belongs in the trunk's fork.
    expect(reach).toBeLessThan(5)
  })

  it('sizes the fillet from the thinner member of each union', () => {
    const local = junctionNeighbourhood(limb, byId)!
    expect(local.blendRadius).toBeGreaterThan(0.3)
    expect(local.blendRadius).toBeLessThan(0.7)
    expect(local.maximumSwell).toBeLessThan(local.blendRadius)
  })

  it('has nothing to blend for an isolated part', () => {
    const orphan = part({ id: 'orphan', spine: spine([[0, 0, 0], [0, 1, 0]], [0.2, 0.1]) })
    expect(junctionNeighbourhood(orphan, new Map([['orphan', orphan]]))).toBeUndefined()
  })

  it('does not inflate an index-stitched continuation as a second solid', () => {
    const parent = part({
      id: 'parent',
      children: ['continuation'],
      continuationChildId: 'continuation',
      spine: spine([[0, 0, 0], [0, 2, 0]], [0.6, 0.5]),
    })
    const continuation = part({
      id: 'continuation',
      parentId: 'parent',
      junctionType: 'continuation',
      spine: spine([[0, 2, 0], [0.4, 4, 0]], [0.5, 0.35]),
    })
    const parts = new Map([parent, continuation].map((entry) => [entry.id, entry]))

    expect(junctionNeighbourhood(parent, parts)).toBeUndefined()
    expect(junctionNeighbourhood(continuation, parts)).toBeUndefined()
  })
})
