import { describe, expect, it } from 'vitest'
import { generateSemanticTree } from './semanticGraph'
import { deriveTreeHabit } from './treeHabit'
import {
  DEFAULT_TREE_ENVIRONMENT,
  DEFAULT_TREE_PARAMETERS,
  normalizeTreeParameters,
  type SemanticTreePart,
} from './types'

describe('semantic tree graph', () => {
  it('is deterministic and preserves semantic continuation relationships', () => {
    const first = generateSemanticTree(DEFAULT_TREE_PARAMETERS, DEFAULT_TREE_ENVIRONMENT)
    const second = generateSemanticTree(DEFAULT_TREE_PARAMETERS, DEFAULT_TREE_ENVIRONMENT)

    expect(second).toEqual(first)
    const trunk = first.parts.find((part) => part.type === 'trunk')
    const leader = first.parts.find((part) => part.id === 'leader')
    expect(trunk?.continuationChildId).toBe('leader')
    expect(leader?.junctionType).toBe('continuation')
    // Colonisation decides the ramification count, so the assertion is that the
    // crown is genuinely deep and branched rather than that it hit a number.
    const limbs = first.parts.filter(
      (part) => part.type === 'branch' || part.type === 'twig',
    )
    expect(limbs.length).toBeGreaterThan(60)
    expect(Math.max(...limbs.map((part) => part.branchOrder))).toBeGreaterThanOrEqual(3)
    expect(first.parts.filter(
      (part) => part.type === 'root' && part.branchOrder === 1,
    ))
      .toHaveLength(DEFAULT_TREE_PARAMETERS.rootCount)
    expect(first.parts.filter((part) => part.type === 'root' && part.branchOrder === 2).length)
      .toBeGreaterThan(0)
  })

  it('builds changing root burial and non-circular structural cross sections', () => {
    const graph = generateSemanticTree(DEFAULT_TREE_PARAMETERS, DEFAULT_TREE_ENVIRONMENT)
    const roots = graph.parts.filter(
      (part) => part.type === 'root' && part.branchOrder === 1,
    )
    for (const root of roots) {
      const relativeDepths = root.spine.map(
        (sample) => sample.burialDepth / sample.crossSection.radiusZ,
      )
      expect(Math.min(...relativeDepths)).toBeLessThan(0.8)
      expect(Math.max(...relativeDepths)).toBeGreaterThan(1.1)
      expect(
        Math.max(
          ...root.spine.map(
            (sample) => sample.crossSection.radiusX / sample.crossSection.radiusZ,
          ),
        ),
      ).toBeGreaterThan(1.4)
    }

    const buriedForks = graph.parts.filter(
      (part) => part.type === 'root' && part.branchOrder === 2,
    )
    for (const fork of buriedForks) {
      expect(Math.min(
        ...fork.spine.map(
          (sample) => sample.burialDepth / sample.crossSection.radiusZ,
        ),
      )).toBeGreaterThan(1)
    }

    const trunk = graph.parts.find((part) => part.type === 'trunk')!
    // The flare remains visibly non-circular, but the directional roots now do
    // the heavy silhouette work instead of a regular high-amplitude skirt.
    // Buttressing is a handful of broad ribs, not one rib per root: matching
    // the root count exactly turned the whole bole into a fluted column.
    expect(trunk.spine[0]!.crossSection.lobeStrength).toBeGreaterThan(0.07)
    expect(trunk.spine[0]!.crossSection.lobeCount).toBeGreaterThanOrEqual(3)
    expect(trunk.spine[0]!.crossSection.lobeCount)
      .toBeLessThan(DEFAULT_TREE_PARAMETERS.rootCount)
    // …and it dies out well before the crown.
    expect(trunk.spine.at(-1)!.crossSection.lobeStrength).toBeLessThan(0.01)
  })

  it('keeps child cross-sectional area within its attachment budget', () => {
    const graph = generateSemanticTree(DEFAULT_TREE_PARAMETERS, DEFAULT_TREE_ENVIRONMENT)
    const byId = new Map(graph.parts.map((part) => [part.id, part]))
    for (const child of graph.parts) {
      if (!child.parentId || child.type === 'root') continue
      const parent = byId.get(child.parentId)!
      const parentRadius = radiusAt(parent, child.attachment)
      expect(child.spine[0]!.radius ** 2).toBeLessThanOrEqual(parentRadius ** 2 * 0.9)
    }
  })

  it('gives every member a unique id and at most one continuation per parent', () => {
    // Two chains can pass through the same growth node — the axis, and a fork
    // leaving it — and both once claimed to be that node's own member. They got
    // the same id and both declared themselves the trunk's continuation, so two
    // meshes shared one ring and the surface stopped being manifold there.
    for (const seed of [73129, 9174, 45866, 275191]) {
      const graph = generateSemanticTree(
        { ...DEFAULT_TREE_PARAMETERS, seed },
        DEFAULT_TREE_ENVIRONMENT,
      )
      const ids = graph.parts.map((part) => part.id)
      expect(new Set(ids).size).toBe(ids.length)
      const continuationsByParent = new Map<string, number>()
      for (const part of graph.parts) {
        if (part.junctionType !== 'continuation' || !part.parentId) continue
        const count = (continuationsByParent.get(part.parentId) ?? 0) + 1
        continuationsByParent.set(part.parentId, count)
        expect(count).toBe(1)
      }
    }
  }, 30_000)

  it('keeps every member inside a plausible envelope for its recipe', () => {
    // Union swelling used to be applied as one multiply per child. A limb in a
    // colonised crown carries dozens of children, many at the same station, so
    // the factors compounded and a fifteen-centimetre branch could come out a
    // hundred metres across — which the relaxation pass then flung across the
    // map as a sheet of stray geometry.
    for (const seed of [73129, 9174, 45866, 91731, 275191, 321056]) {
      const parameters = { ...DEFAULT_TREE_PARAMETERS, seed }
      const graph = generateSemanticTree(parameters, DEFAULT_TREE_ENVIRONMENT)
      const reach = parameters.height + parameters.crownRadius
      for (const part of graph.parts) {
        for (const sample of part.spine) {
          expect(Number.isFinite(sample.radius)).toBe(true)
          expect(sample.radius).toBeLessThan(parameters.trunkRadius * 4)
          expect(sample.crossSection.radiusX).toBeLessThan(parameters.trunkRadius * 6)
          expect(Math.abs(sample.position.x)).toBeLessThan(reach)
          expect(Math.abs(sample.position.y)).toBeLessThan(reach)
          expect(Math.abs(sample.position.z)).toBeLessThan(reach)
        }
      }
    }
  }, 30_000)

  it('produces structurally different trees from different seeds', () => {
    // Variety has to be a property of the *architecture*, not of jitter. Two
    // seeds that differ only in where their noise lands still produce the same
    // tree; these have to differ in bole form, crown form or root form.
    const habits = new Set<string>()
    for (let index = 0; index < 24; index += 1) {
      const parameters = normalizeTreeParameters({
        ...DEFAULT_TREE_PARAMETERS,
        seed: 1000 + index * 7919,
      })
      const habit = deriveTreeHabit(parameters)
      habits.add(`${habit.boleForm}/${habit.crownForm}/${habit.rootForm}`)
    }
    expect(habits.size).toBeGreaterThan(8)
  }, 10_000)

  it('lets an author pin a form instead of leaving it to the seed', () => {
    for (let index = 0; index < 8; index += 1) {
      const habit = deriveTreeHabit(normalizeTreeParameters({
        ...DEFAULT_TREE_PARAMETERS,
        seed: 500 + index * 1301,
        boleForm: 'codominant',
        rootForm: 'stilted',
      }))
      expect(habit.boleForm).toBe('codominant')
      expect(habit.rootForm).toBe('stilted')
      expect(habit.forkHeight).toBeGreaterThan(0)
    }
  })

  it('keeps structural contacts separate from the parent-child graph', () => {
    const graph = generateSemanticTree(
      { ...DEFAULT_TREE_PARAMETERS, seed: 12347, gnarl: 0.95 },
      DEFAULT_TREE_ENVIRONMENT,
    )
    for (const contact of graph.contacts) {
      const a = graph.parts.find((part) => part.id === contact.partA)!
      const b = graph.parts.find((part) => part.id === contact.partB)!
      expect(a.parentId).not.toBe(b.id)
      expect(b.parentId).not.toBe(a.id)
      expect(contact.pressure).toBeGreaterThanOrEqual(0)
      expect(contact.pressure).toBeLessThanOrEqual(1)
    }
  })
})

function radiusAt(part: SemanticTreePart, amount: number): number {
  const scaled = amount * (part.spine.length - 1)
  const left = Math.floor(scaled)
  const right = Math.min(part.spine.length - 1, left + 1)
  const fraction = scaled - left
  return part.spine[left]!.radius +
    (part.spine[right]!.radius - part.spine[left]!.radius) * fraction
}
