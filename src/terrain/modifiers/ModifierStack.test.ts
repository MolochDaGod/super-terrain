import { describe, expect, it } from 'vitest'
import { ModifierStack } from './ModifierStack'
import { createBrushStroke, createRemeshModifier } from './factories'
import { materializeModifierTransforms, modifierWorldBounds } from './transform'

describe('modifier stack', () => {
  it('orders modifiers deterministically by priority then id', () => {
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
})
