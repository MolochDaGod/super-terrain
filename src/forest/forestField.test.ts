import { describe, expect, it } from 'vitest'
import {
  buildForestRegion,
  sampleForestSpline,
  type ForestField,
} from './forestField'
import { generateForestLayoutInRegion } from '../tree/forestPresets'

function field(overrides: Partial<ForestField> = {}): ForestField {
  return {
    id: 'test',
    name: 'Test',
    nodes: [
      { x: -100, z: -100 },
      { x: 100, z: -100 },
      { x: 100, z: 100 },
      { x: -100, z: 100 },
    ],
    closed: true,
    width: 30,
    feather: 20,
    preset: 'mossy-old-growth',
    density: 1,
    seed: 1234,
    visible: true,
    dirty: true,
    ...overrides,
  }
}

describe('sampleForestSpline', () => {
  it('closes the loop without repeating the first node', () => {
    const points = sampleForestSpline(field().nodes, true)
    expect(points.length).toBeGreaterThan(4)
    const first = points[0]!
    const last = points[points.length - 1]!
    // The last sample runs back toward the first rather than landing on it —
    // the segment between them is what closes the ring.
    expect(Math.hypot(last.x - first.x, last.z - first.z)).toBeGreaterThan(0)
    expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)))
      .toBe(true)
  })

  it('survives coincident control points', () => {
    // Centripetal parameterisation exists for exactly this: dragging one node
    // onto another must not produce a cusp, a loop, or a division by zero.
    const points = sampleForestSpline(
      [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 10, z: 0 },
        { x: 10, z: 10 },
      ],
      true,
    )
    expect(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)))
      .toBe(true)
  })
})

describe('buildForestRegion', () => {
  it('is fully covered inside and empty outside', () => {
    const region = buildForestRegion(field())!
    expect(region).not.toBeNull()
    expect(region.coverage(0, 0)).toBeGreaterThan(0.99)
    expect(region.coverage(200, 0)).toBe(0)
    expect(region.coverage(1_000, 1_000)).toBe(0)
  })

  it('passes through its control points and bows outward between them', () => {
    // A curve through four corners is not the square: it passes through each
    // node and bows out between them, which is what makes a four-node field a
    // rounded shape rather than a quadrilateral. Worth pinning down, because
    // the temptation on reading the coverage of a corner is to conclude the
    // fringe is broken.
    const region = buildForestRegion(field({ feather: 4 }))!
    // A control point is on the boundary: the fringe is centred there, so it
    // reads about half.
    expect(region.coverage(-100, -100)).toBeGreaterThan(0.2)
    expect(region.coverage(-100, -100)).toBeLessThan(0.8)
    // The middle of an edge is pushed outward past its own control points.
    expect(region.coverage(100, 0)).toBeGreaterThan(0.9)
    expect(region.coverage(130, 0)).toBe(0)
  })

  it('fades across the fringe rather than stepping', () => {
    const region = buildForestRegion(field({ feather: 40 }))!
    const samples = [80, 90, 100, 110, 120].map((x) => region.coverage(x, 0))
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]!).toBeLessThanOrEqual(samples[index - 1]! + 1e-6)
    }
    // A step would put every sample at 0 or 1. A fringe puts them in between.
    expect(samples.some((value) => value > 0.05 && value < 0.95)).toBe(true)
  })

  it('measures an area between the drawn polygon and its circumcircle', () => {
    const region = buildForestRegion(field({ feather: 1 }))!
    // The spline bows outward, so the enclosed area is more than the 200 m
    // square through the same four nodes and less than the circle through
    // their corners. That area is what sets the stem budget, so it is worth a
    // bound rather than a shrug.
    expect(region.area).toBeGreaterThan(200 * 200)
    expect(region.area).toBeLessThan(Math.PI * Math.hypot(100, 100) ** 2)
  })

  it('treats an open spline as a belt of its own width', () => {
    const region = buildForestRegion(
      field({
        closed: false,
        width: 25,
        feather: 10,
        nodes: [
          { x: -100, z: 0 },
          { x: 100, z: 0 },
        ],
      }),
    )!
    expect(region.coverage(0, 0)).toBeGreaterThan(0.99)
    expect(region.coverage(0, 18)).toBeGreaterThan(0.5)
    expect(region.coverage(0, 45)).toBe(0)
  })

  it('needs two nodes', () => {
    expect(buildForestRegion(field({ nodes: [{ x: 0, z: 0 }] }))).toBeNull()
    expect(buildForestRegion(field({ nodes: [] }))).toBeNull()
  })
})

describe('generateForestLayoutInRegion', () => {
  it('plants only where the region says there is forest', () => {
    const region = buildForestRegion(field({ feather: 4 }))!
    const trees = generateForestLayoutInRegion('mossy-old-growth', 99, region, 1)
    expect(trees.length).toBeGreaterThan(20)
    for (const tree of trees) {
      expect(region.coverage(tree.position[0], tree.position[2])).toBeGreaterThan(0)
    }
  })

  it('thins toward the edge instead of stopping at it', () => {
    const region = buildForestRegion(field({ feather: 60 }))!
    const trees = generateForestLayoutInRegion('mossy-old-growth', 7, region, 1)
    const fringe = trees.filter(
      (tree) => region.coverage(tree.position[0], tree.position[2]) < 0.5,
    )
    // Some stems stand out in the fringe — that is what stops the stand
    // reading as a wall — but the fringe is never the bulk of them.
    expect(fringe.length).toBeGreaterThan(0)
    expect(fringe.length).toBeLessThan(trees.length * 0.5)
  })

  it('is deterministic for a seed', () => {
    const region = buildForestRegion(field())!
    const a = generateForestLayoutInRegion('temperate-mixed', 4242, region, 1)
    const b = generateForestLayoutInRegion('temperate-mixed', 4242, region, 1)
    expect(a).toEqual(b)
  })

  it('spends more stems on a denser field', () => {
    const region = buildForestRegion(field())!
    const sparse = generateForestLayoutInRegion('mossy-old-growth', 11, region, 0.4)
    const dense = generateForestLayoutInRegion('mossy-old-growth', 11, region, 1.4)
    expect(dense.length).toBeGreaterThan(sparse.length)
  })
})
