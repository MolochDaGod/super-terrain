import { describe, expect, it } from 'vitest'
import { generateSemanticTree } from './semanticGraph'
import { deriveTreeHabit } from './treeHabit'
import {
  DEFAULT_TREE_ENVIRONMENT,
  DEFAULT_TREE_PARAMETERS,
  normalizeTreeParameters,
  type SemanticTreePart,
  type TreeBolePlan,
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
  }, 10_000)

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
    // tree; these have to differ in plan, axis, damage, crown or root form.
    const habits = new Set<string>()
    for (let index = 0; index < 24; index += 1) {
      const parameters = normalizeTreeParameters({
        ...DEFAULT_TREE_PARAMETERS,
        seed: 1000 + index * 7919,
      })
      const habit = deriveTreeHabit(parameters)
      habits.add(
        `${habit.bolePlan}/${habit.axisForm}/${habit.trunkDamage}/` +
          `${habit.crownForm}/${habit.rootForm}`,
      )
    }
    expect(habits.size).toBeGreaterThan(8)
  }, 10_000)

  it('lets an author pin a form instead of leaving it to the seed', () => {
    for (let index = 0; index < 8; index += 1) {
      const habit = deriveTreeHabit(normalizeTreeParameters({
        ...DEFAULT_TREE_PARAMETERS,
        seed: 500 + index * 1301,
        bolePlan: 'codominant',
        axisForm: 'sinuous',
        trunkDamage: 'intact',
        rootForm: 'stilted',
      }))
      expect(habit.bolePlan).toBe('codominant')
      expect(habit.axisForm).toBe('sinuous')
      expect(habit.trunkDamage).toBe('intact')
      expect(habit.rootForm).toBe('stilted')
      expect(habit.forkHeight).toBeGreaterThan(0)
    }
  })

  it('uses the authored twist to control fused-stem weave and handedness', () => {
    const gentle = deriveTreeHabit(normalizeTreeParameters({
      ...DEFAULT_TREE_PARAMETERS,
      seed: 9917,
      bolePlan: 'fused',
      twist: 0.2,
    }))
    const strong = deriveTreeHabit(normalizeTreeParameters({
      ...DEFAULT_TREE_PARAMETERS,
      seed: 9917,
      bolePlan: 'fused',
      twist: 6,
    }))
    const reverse = deriveTreeHabit(normalizeTreeParameters({
      ...DEFAULT_TREE_PARAMETERS,
      seed: 9917,
      bolePlan: 'fused',
      twist: -6,
    }))
    expect(Math.abs(strong.stemTwist)).toBeGreaterThan(Math.abs(gentle.stemTwist) * 2)
    expect(strong.stemTwist).toBe(6)
    expect(strong.stemTwist).toBeGreaterThan(0)
    expect(reverse.stemTwist).toBe(-6)
  })

  it('scales a fused bole with the full authored trunk radius', () => {
    const make = (trunkRadius: number) => {
      const parameters = normalizeTreeParameters({
        ...DEFAULT_TREE_PARAMETERS,
        seed: 84721,
        bolePlan: 'fused',
        axisForm: 'sinuous',
        trunkDamage: 'intact',
        trunkRadius,
        branchCount: 5,
        rootCount: 5,
        foliageDensity: 0,
      })
      const graph = generateSemanticTree(parameters, DEFAULT_TREE_ENVIRONMENT)
      const stems = graph.parts.filter(
        (part) => part.type === 'trunk' && part.parentId === 'trunk',
      )
      const station = Math.floor(stems[0]!.spine.length * 0.5)
      return {
        parameters,
        equivalentRadius: Math.sqrt(stems.reduce(
          (area, stem) => area + stem.spine[station]!.radius ** 2,
          0,
        )),
        contactRatio: distanceBetween(
          stems[0]!.spine[station]!.position,
          stems[1]!.spine[station]!.position,
        ) / (
          stems[0]!.spine[station]!.radius +
          stems[1]!.spine[station]!.radius
        ),
      }
    }

    const thin = make(0.5)
    const thick = make(2.2)
    // This used to read 2.2 from the slider and silently normalize to 1.6.
    expect(thick.parameters.trunkRadius).toBe(2.2)
    expect(thick.equivalentRadius / thin.equivalentRadius).toBeCloseTo(4.4, 1)
    expect(thick.equivalentRadius).toBeGreaterThan(2.2 * 0.5)
    // Orbit and girth scale together, so increasing radius does not pull the
    // strands apart or bury one entirely inside the other.
    expect(thick.contactRatio).toBeCloseTo(thin.contactRatio, 1)
  }, 20_000)

  it('builds low divided boles as trunk-scale axes rather than crown branches', () => {
    const expected = [
      ['codominant', 2],
      ['multistem', 3],
      ['fused', 2],
    ] as const satisfies readonly (readonly [TreeBolePlan, number])[]
    for (const [bolePlan, minimumCount] of expected) {
      const graph = generateSemanticTree(
        {
          ...DEFAULT_TREE_PARAMETERS,
          seed: 84721,
          bolePlan,
          axisForm: bolePlan === 'fused' ? 'sinuous' : 'auto',
        },
        DEFAULT_TREE_ENVIRONMENT,
      )
      const trunk = graph.parts.find((part) => part.id === 'trunk')!
      const stems = graph.parts.filter(
        (part) => part.type === 'trunk' && part.parentId === trunk.id,
      )
      expect(stems.length).toBeGreaterThanOrEqual(minimumCount)
      expect(trunk.spine.at(-1)!.position.y).toBeLessThan(
        DEFAULT_TREE_PARAMETERS.height * 0.2,
      )
      expect(stems.every((stem) => stem.branchOrder === 0)).toBe(true)
      if (bolePlan === 'fused') {
        const centers = stems[0]!.spine.map((_, index) => {
          const samples = stems.map((stem) => stem.spine[index]!.position)
          return {
            x: samples.reduce((sum, sample) => sum + sample.x, 0) / samples.length,
            y: samples.reduce((sum, sample) => sum + sample.y, 0) / samples.length,
            z: samples.reduce((sum, sample) => sum + sample.z, 0) / samples.length,
          }
        })
        const turns = stems.map((stem) => {
          let accumulated = 0
          let previous = Math.atan2(
            stem.spine[1]!.position.z - centers[1]!.z,
            stem.spine[1]!.position.x - centers[1]!.x,
          )
          for (let index = 2; index < stem.spine.length; index += 1) {
            const sample = stem.spine[index]!
            const angle = Math.atan2(
              sample.position.z - centers[index]!.z,
              sample.position.x - centers[index]!.x,
            )
            accumulated += Math.abs(Math.atan2(
              Math.sin(angle - previous),
              Math.cos(angle - previous),
            ))
            previous = angle
          }
          return accumulated
        })
        expect(Math.min(...turns)).toBeGreaterThan(Math.PI * 2.2)

        const start = centers[0]!
        const end = centers.at(-1)!
        const axisDeviation = Math.max(...centers.map((center, index) => {
          const t = index / (centers.length - 1)
          return Math.hypot(
            center.x - (start.x + (end.x - start.x) * t),
            center.z - (start.z + (end.z - start.z) * t),
          )
        }))
        expect(axisDeviation).toBeGreaterThan(0.2)

        const first = stems[0]!
        const second = stems[1]!
        let nearContacts = 0
        for (let index = 1; index < first.spine.length; index += 1) {
          const a = first.spine[index]!
          const b = second.spine[index]!
          const separation = Math.hypot(
            a.position.x - b.position.x,
            a.position.y - b.position.y,
            a.position.z - b.position.z,
          )
          if (separation < (a.radius + b.radius) * 1.08) nearContacts += 1
        }
        expect(nearContacts).toBeGreaterThan(5)
      }
    }
  }, 20_000)

  it('carries buttress fins up the basal axes and broad plates along the soil', () => {
    const graph = generateSemanticTree(
      {
        ...DEFAULT_TREE_PARAMETERS,
        bolePlan: 'multistem',
        rootForm: 'buttressed',
      },
      DEFAULT_TREE_ENVIRONMENT,
    )
    const axes = graph.parts.filter((part) => part.type === 'trunk')
    expect(axes.every((axis) => axis.spine[0]!.crossSection.fins?.length)).toBeTruthy()

    const roots = graph.parts.filter(
      (part) => part.type === 'root' && part.branchOrder === 1,
    )
    for (const root of roots) {
      const plate = root.spine.slice(
        Math.floor(root.spine.length * 0.18),
        Math.ceil(root.spine.length * 0.5),
      )
      expect(Math.max(...plate.map(
        (sample) => sample.crossSection.radiusX / sample.radius,
      ))).toBeGreaterThan(1.2)
      expect(Math.max(...plate.map(
        (sample) => (sample.position.y + sample.crossSection.radiusZ) /
          sample.crossSection.radiusZ,
      ))).toBeGreaterThan(-0.15)
    }
  }, 20_000)

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

function distanceBetween(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}
