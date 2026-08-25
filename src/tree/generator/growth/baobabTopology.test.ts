import { describe, expect, it } from 'vitest'
import { fusedStemRadius } from '../fusedStems'
import { generateSemanticTree } from '../semanticGraph'
import {
  DEFAULT_TREE_ENVIRONMENT,
  TREE_SPECIES_PRESETS,
  type SemanticTreeGraph,
  type SemanticTreePart,
} from '../types'

const tree: SemanticTreeGraph = generateSemanticTree(
  TREE_SPECIES_PRESETS.baobab,
  DEFAULT_TREE_ENVIRONMENT,
)
const trunk = tree.parts.find((part) => part.id === 'trunk')!
const divisions = tree.parts.filter((part) => /^baobab-division-\d+$/.test(part.id))

function outlineAt(sample: SemanticTreePart['spine'][number], azimuth: number): number {
  const lobes = sample.crossSection.fusedStems
  if (!lobes) return sample.radius
  return fusedStemRadius(
    lobes,
    Math.cos(azimuth),
    Math.sin(azimuth),
    sample.crossSection.fusedStemBlend ?? 0,
  ) * sample.radius
}

describe('baobab bole anatomy', () => {
  it('is a union of fused stems rather than a revolved outline', () => {
    for (const sample of trunk.spine) {
      expect(sample.crossSection.fusedStems?.length ?? 0).toBeGreaterThanOrEqual(3)
    }
    // The whole point of the union is that the plan is not a circle. Measure the
    // spread of the outline around one mid-bole station.
    const mid = trunk.spine[Math.floor(trunk.spine.length * 0.5)]!
    const radii: number[] = []
    for (let step = 0; step < 64; step += 1) {
      radii.push(outlineAt(mid, (step / 64) * Math.PI * 2))
    }
    expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(1.12)
  })

  it('keeps the outline continuous from station to station', () => {
    // A discontinuity here is a hard horizontal ledge wrapped round the bole,
    // which is exactly what an outline reseeded per station produced.
    let worstSlope = 0
    for (let index = 1; index < trunk.spine.length; index += 1) {
      const below = trunk.spine[index - 1]!
      const above = trunk.spine[index]!
      const rise = Math.abs(above.position.y - below.position.y)
      if (rise < 1e-4) continue
      for (let step = 0; step < 32; step += 1) {
        const azimuth = (step / 32) * Math.PI * 2
        const change = Math.abs(outlineAt(above, azimuth) - outlineAt(below, azimuth))
        worstSlope = Math.max(worstSlope, change / rise)
      }
    }
    expect(worstSlope).toBeLessThan(1)
  })

  it('spreads into a foot at the ground line instead of meeting it as a wall', () => {
    const atGround = trunk.spine.reduce((best, sample) =>
      Math.abs(sample.position.y) < Math.abs(best.position.y) ? sample : best)
    const clear = trunk.spine.reduce((best, sample) =>
      Math.abs(sample.position.y - 3) < Math.abs(best.position.y - 3) ? sample : best)
    expect(atGround.radius / clear.radius).toBeGreaterThan(1.18)
  })

  it('stays massive where it divides rather than pinching to a neck', () => {
    const mid = trunk.spine[Math.floor(trunk.spine.length * 0.35)]!.radius
    const top = trunk.spine.at(-1)!.radius
    expect(mid / top).toBeGreaterThan(1.2)
    expect(mid / top).toBeLessThan(1.9)
  })
})

describe('baobab crown division', () => {
  it('resolves into a few unequal trunk-scale limbs from the upper bole', () => {
    expect(divisions.length).toBeGreaterThanOrEqual(4)
    expect(divisions.length).toBeLessThanOrEqual(6)
    expect(divisions.filter((part) => part.junctionType === 'continuation'))
      .toHaveLength(1)
    // Every division leaves the top of the bole. Scattering them down the flank
    // is what produced the octopus reading in review.
    expect(divisions.every((part) => part.attachment >= 0.88)).toBe(true)
    const topRadius = trunk.spine.at(-1)!.radius
    for (const division of divisions) {
      const base = division.spine[0]!.radius
      expect(base / topRadius).toBeGreaterThan(0.3)
      expect(base / topRadius).toBeLessThan(0.95)
    }
    const bases = divisions.map((part) => part.spine[0]!.radius)
    expect(Math.max(...bases) / Math.min(...bases)).toBeGreaterThan(1.15)
  })

  it('climbs before it spreads', () => {
    for (const division of divisions) {
      const first = division.spine[0]!.position
      const last = division.spine.at(-1)!.position
      const climb = last.y - first.y
      const reach = Math.hypot(last.x - first.x, last.z - first.z)
      // Not a vertical mast and not a horizontal pipe: a limb that gains real
      // height over its run while still carrying the crown outward.
      expect(climb).toBeGreaterThan(0.3 * reach)
      expect(reach).toBeGreaterThan(0.2 * climb)
    }
  })
})

describe('baobab terminal shoots', () => {
  const twigs = tree.parts.filter((part) => part.id.includes('-twig-'))

  it('ends every path in a fan of short crooked shoots', () => {
    expect(twigs.length).toBeGreaterThan(200)
    const byBearer = new Map<string, number>()
    for (const twig of twigs) {
      byBearer.set(twig.parentId!, (byBearer.get(twig.parentId!) ?? 0) + 1)
    }
    const counts = [...byBearer.values()]
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(4)
    expect(Math.max(...counts)).toBeLessThanOrEqual(7)
  })

  it('packs foliage into masses on the shoots rather than along bare wood', () => {
    expect(tree.foliageClusters.length).toBeGreaterThan(500)
    const carriers = new Set(tree.foliageClusters.map((cluster) => cluster.partId))
    for (const partId of carriers) expect(partId).toContain('-twig-')

    // A mass is a mass only if its stations overlap. Measure each station's
    // nearest neighbour against the cards it carries.
    const sample = tree.foliageClusters.slice(0, 400)
    let lonely = 0
    for (const cluster of sample) {
      let nearest = Infinity
      for (const other of sample) {
        if (other === cluster) continue
        nearest = Math.min(nearest, Math.hypot(
          other.center.x - cluster.center.x,
          other.center.y - cluster.center.y,
          other.center.z - cluster.center.z,
        ))
      }
      if (nearest > cluster.radius * 2) lonely += 1
    }
    expect(lonely / sample.length).toBeLessThan(0.1)
  })

  it('puts leaf mass inside the crown, not only on its outer shell', () => {
    const orders = new Set(twigs.map((part) => part.branchOrder))
    // Exhausted axes flower early, so shoots exist at more than one order.
    expect(orders.size).toBeGreaterThanOrEqual(3)
  })
})
