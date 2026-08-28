import { describe, expect, it } from 'vitest'
import { generateForestLayout } from './forestPresets'

const PRESET = 'mossy-old-growth'
const SEED = 42017

function radii(trees: ReturnType<typeof generateForestLayout>): number[] {
  return trees
    .map((tree) => Math.hypot(tree.position[0], tree.position[2]))
    .sort((a, b) => a - b)
}

/**
 * Index of dispersion over grove-sized cells: the variance of the per-cell
 * stem count over its mean. A uniform random scatter sits at 1; grouping into
 * stands and glades pushes it above that.
 */
function dispersion(
  trees: ReturnType<typeof generateForestLayout>,
  radius: number,
  cell = 16,
): number {
  const counts = new Map<string, number>()
  const cells: string[] = []
  const span = Math.ceil(radius / cell)
  for (let gz = -span; gz <= span; gz += 1) {
    for (let gx = -span; gx <= span; gx += 1) {
      // Cells whose centre is well inside the disc. Including the rim would
      // count the ground outside the stand as glade and inflate the variance
      // without anything having clustered.
      if (Math.hypot((gx + 0.5) * cell, (gz + 0.5) * cell) > radius - cell) continue
      cells.push(`${gx}:${gz}`)
    }
  }
  const inside = new Set(cells)
  for (const tree of trees) {
    const key = `${Math.floor(tree.position[0] / cell)}:${Math.floor(tree.position[2] / cell)}`
    if (inside.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const values = cells.map((key) => counts.get(key) ?? 0)
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return variance / Math.max(mean, 1e-6)
}

/** Share of grove-sized cells inside the stand holding no stems at all. */
function emptyCellFraction(
  trees: ReturnType<typeof generateForestLayout>,
  radius: number,
  cell = 16,
): number {
  const occupied = new Set<string>()
  for (const tree of trees) {
    occupied.add(
      `${Math.floor(tree.position[0] / cell)}:${Math.floor(tree.position[2] / cell)}`,
    )
  }
  let inside = 0
  let empty = 0
  const span = Math.ceil(radius / cell)
  for (let gz = -span; gz <= span; gz += 1) {
    for (let gx = -span; gx <= span; gx += 1) {
      if (Math.hypot((gx + 0.5) * cell, (gz + 0.5) * cell) > radius - cell) continue
      inside += 1
      if (!occupied.has(`${gx}:${gz}`)) empty += 1
    }
  }
  return empty / Math.max(inside, 1)
}

describe('forest layout', () => {
  it('fills the radius it was given instead of a disc in the middle of it', () => {
    for (const radius of [45, 70, 100]) {
      const distances = radii(generateForestLayout(PRESET, SEED, radius, 1))
      // The furthest stem has to be near the edge, and the stand has to reach
      // it gradually rather than stopping short — the old layout drew clusters
      // inside 0.72 of the radius and left the rest of the world bare.
      expect(distances.at(-1)!).toBeGreaterThan(radius * 0.85)
      const outerThird = distances.filter((d) => d > radius * 0.667).length
      expect(outerThird / distances.length).toBeGreaterThan(0.3)
    }
  })

  it('spends a stem budget on extent rather than multiplying trees with area', () => {
    const counts = [30, 45, 70, 100].map(
      (radius) => generateForestLayout(PRESET, SEED, radius, 1).length,
    )
    // Growing, because a wider world should read as more forest.
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]!).toBeGreaterThan(counts[i - 1]!)
    }
    // But nothing like the square of the radius. At this preset's own density
    // a hundred-metre stand would be seventeen thousand trees.
    const areaRatio = (100 / 30) ** 2
    expect(counts.at(-1)! / counts[0]!).toBeLessThan(areaRatio * 0.35)
    expect(counts.at(-1)!).toBeLessThanOrEqual(480)
  })

  it('covers the ground it spreads over instead of clumping into islands', () => {
    for (const radius of [70, 140]) {
      const trees = generateForestLayout(PRESET, SEED, radius, 1)
      // Density varies across the stand — a forest is not a plantation — but
      // it stays woodland throughout. Concentrating the budget into a fraction
      // of the ground reads as islands of trees with country between them,
      // which is a landscape and is not a forest you can walk into.
      const spread = dispersion(trees, radius)
      expect(spread).toBeGreaterThan(0.15)
      expect(spread).toBeLessThan(2)
      expect(emptyCellFraction(trees, radius)).toBeLessThan(0.12)
    }
  })

  it('keeps the middle of the world planted, wherever the noise falls', () => {
    // The camera starts at the origin. Whether it starts among trees must not
    // depend on what the broad octave happens to do there.
    for (const seed of [1, 7, 42017, 90210, 777_777]) {
      const trees = generateForestLayout(PRESET, seed, 70, 1)
      const near = trees.filter(
        (tree) => Math.hypot(tree.position[0], tree.position[2]) < 18,
      )
      expect(near.length).toBeGreaterThan(8)
    }
  })

  it('is deterministic in the seed', () => {
    const a = generateForestLayout(PRESET, 1234, 70, 1)
    const b = generateForestLayout(PRESET, 1234, 70, 1)
    expect(a).toEqual(b)
    expect(generateForestLayout(PRESET, 1235, 70, 1)).not.toEqual(a)
  })

  it('places every stand within its radius', () => {
    for (const preset of ['mossy-old-growth', 'ancient-oak-grove', 'boreal-conifer'] as const) {
      for (const tree of generateForestLayout(preset, SEED, 70, 1)) {
        expect(Math.hypot(tree.position[0], tree.position[2])).toBeLessThanOrEqual(70)
      }
    }
  })
})
