import { describe, expect, it } from 'vitest'
import { ModifierStack } from './ModifierStack'
import { createBrushStroke, createRemeshModifier } from './factories'
import { materializeModifierTransforms, modifierWorldBounds } from './transform'

describe('modifier stack', () => {
  it('orders modifiers by priority, whatever order they were added in', () => {
    const stack = new ModifierStack()
    const brush = createBrushStroke({
      point: { x: 0, y: 0, z: 0 },
      mode: 'raise',
      radius: 10,
      strength: 0.5,
      falloff: 0.5,
    })
    const remesh = createRemeshModifier({
      center: { x: 0, y: 0, z: 0 },
      radius: 20,
      targetEdgeLength: 2,
    })
    stack.add(brush)
    stack.add(remesh)
    expect(stack.query(remesh.bounds).map((modifier) => modifier.type)).toEqual([
      'remesh',
      'brush-stroke',
    ])
  })

  it('only returns spatially intersecting enabled modifiers', () => {
    const stack = new ModifierStack()
    const near = createRemeshModifier({
      center: { x: 0, y: 0, z: 0 },
      radius: 4,
      targetEdgeLength: 1,
    })
    const far = createRemeshModifier({
      center: { x: 100, y: 0, z: 100 },
      radius: 4,
      targetEdgeLength: 1,
    })
    far.enabled = false
    stack.add(near)
    stack.add(far)
    expect(
      stack.query({ min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } }),
    ).toHaveLength(1)
  })

  it('deduplicates modifiers spanning multiple spatial buckets', () => {
    const stack = new ModifierStack(16)
    const wide = createRemeshModifier({
      center: { x: 16, y: 0, z: 16 },
      radius: 30,
      targetEdgeLength: 1,
    })
    stack.add(wide)
    expect(
      stack.query({
        min: { x: -8, y: -10, z: -8 },
        max: { x: 40, y: 10, z: 40 },
      }),
    ).toEqual([wide])
  })

  it('keeps world-scale modifiers once instead of copying them into every bucket', () => {
    const stack = new ModifierStack(16)
    const global = createRemeshModifier({
      center: { x: 0, y: 0, z: 0 },
      radius: 10_000,
      targetEdgeLength: 4,
    })
    stack.add(global)

    expect(stack.query({
      min: { x: 5_000, y: -10, z: 5_000 },
      max: { x: 5_010, y: 10, z: 5_010 },
    })).toEqual([global])
  })

  it('rebuilds its lazy index after an in-place editor mutation', () => {
    const stack = new ModifierStack(16)
    const modifier = createRemeshModifier({
      center: { x: 0, y: 0, z: 0 },
      radius: 3,
      targetEdgeLength: 1,
    })
    stack.add(modifier)
    expect(stack.query({
      min: { x: -4, y: -4, z: -4 },
      max: { x: 4, y: 4, z: 4 },
    })).toEqual([modifier])

    modifier.center.x = 100
    modifier.bounds = modifierWorldBounds(modifier)
    stack.touch()
    expect(stack.query({
      min: { x: -4, y: -4, z: -4 },
      max: { x: 4, y: 4, z: 4 },
    })).toEqual([])
    expect(stack.query({
      min: { x: 96, y: -4, z: -4 },
      max: { x: 104, y: 4, z: 4 },
    })).toEqual([modifier])
  })

  it('keeps stroke data immutable while materializing move, yaw, and scale', () => {
    const stroke = createBrushStroke({
      point: { x: 10, y: 4, z: 20 },
      normal: { x: 1, y: 0, z: 0 },
      domain: 'mesh',
      mode: 'raise',
      radius: 5,
      strength: 0.5,
      falloff: 0.5,
    })
    stroke.points.push({
      x: 15,
      y: 4,
      z: 20,
      normal: { x: 1, y: 0, z: 0 },
      weight: 1,
    })
    stroke.transform = {
      offset: { x: 3, y: 2, z: -1 },
      yaw: Math.PI / 2,
      scale: 2,
    }
    stroke.bounds = modifierWorldBounds(stroke)
    const [materialized] = materializeModifierTransforms([stroke])
    expect(materialized.type).toBe('brush-stroke')
    if (materialized.type !== 'brush-stroke') return
    expect(materialized.points[0]).toMatchObject({ x: 13, y: 6, z: 19 })
    expect(materialized.points[1]).toMatchObject({ x: 13, y: 6, z: 29 })
    expect(materialized.points[0].normal.x).toBeCloseTo(0, 12)
    expect(materialized.points[0].normal.y).toBeCloseTo(0, 12)
    expect(materialized.points[0].normal.z).toBeCloseTo(1, 12)
    expect(materialized.radius).toBe(10)
    expect(stroke.points[1].x).toBe(15)
  })

  it('evaluates equal-priority strokes in the order they were authored', () => {
    const stack = new ModifierStack()
    // Ids are random UUIDs, so ordering on them shuffled equal-priority strokes.
    // A stroke records its dabs against the surface as it stood when it was
    // drawn: replay several passes out of order and the later ones land where
    // the surface is not yet, miss it entirely, and the built-up shape collapses
    // back to whichever pass happened to sort first.
    const authored = Array.from({ length: 6 }, (_unused, pass) =>
      stack.add(
        createBrushStroke({
          point: { x: 64, y: pass * 8, z: 64 },
          normal: { x: 0, y: 1, z: 0 },
          domain: 'mesh',
          mode: 'raise',
          radius: 22,
          strength: 1,
          falloff: 0.5,
        }),
      ).id,
    )

    const queried = stack
      .query({ min: { x: 40, y: -100, z: 40 }, max: { x: 90, y: 100, z: 90 } })
      .filter((modifier) => modifier.type === 'brush-stroke')
      .map((modifier) => modifier.id)
    expect(queried).toEqual(authored)
    expect(stack.snapshot().map((modifier) => modifier.id)).toEqual(authored)
  })

  it('keeps authored order across a save and reload', () => {
    const stack = new ModifierStack()
    for (let pass = 0; pass < 5; pass += 1) {
      stack.add(
        createBrushStroke({
          point: { x: 64, y: pass * 8, z: 64 },
          normal: { x: 0, y: 1, z: 0 },
          mode: 'raise',
          radius: 22,
          strength: 1,
          falloff: 0.5,
        }),
      )
    }
    const saved = stack.snapshot()
    const reloaded = new ModifierStack()
    reloaded.replace(saved)
    expect(reloaded.snapshot().map((modifier) => modifier.id)).toEqual(
      saved.map((modifier) => modifier.id),
    )
  })
})
