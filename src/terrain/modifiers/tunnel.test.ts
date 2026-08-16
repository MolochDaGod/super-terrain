import { describe, expect, it } from 'vitest'
import { createTunnelModifier } from './factories'
import type { BooleanSubtractModifier } from './types'
import {
  normalizeTunnelModifier,
  tunnelPathPoints,
  tunnelPortalDistance,
  updateTunnelPortal,
} from './tunnel'

describe('tunnel modifiers', () => {
  it('builds a buried swept path from two surface portals', () => {
    const modifier = createTunnelModifier({
      start: { x: 0, y: 20, z: 0, normal: { x: 0, y: 1, z: 0 } },
      end: { x: 30, y: 22, z: 8, normal: { x: 0, y: 1, z: 0 } },
      radius: 5,
      depth: 12,
    })
    const path = tunnelPathPoints(modifier)
    expect(path[0].y).toBeGreaterThan(20)
    expect(path[1].y).toBe(8)
    expect(path[2].y).toBe(10)
    expect(path[3].y).toBeGreaterThan(22)
    expect(tunnelPortalDistance(modifier)).toBeGreaterThan(30)
  })

  it('updates the second portal without replacing the modifier', () => {
    const modifier = createTunnelModifier({
      start: { x: 1, y: 2, z: 3, normal: { x: 0, y: 1, z: 0 } },
    })
    updateTunnelPortal(
      modifier,
      1,
      { x: 12, y: 5, z: 9 },
      { x: 1, y: 1, z: 0 },
    )
    expect(modifier.portals[1]).toMatchObject({ x: 12, y: 5, z: 9 })
    expect(modifier.portals[1].normal.x).toBeCloseTo(Math.SQRT1_2)
  })

  it('migrates fixed v1-v3 A-to-B stamps into portal data', () => {
    const current = createTunnelModifier({ center: { x: 0, y: 0, z: 0 } })
    const legacy = {
      ...current,
      shape: undefined,
      portals: undefined,
      depth: undefined,
      center: { x: 10, y: 4, z: 20 },
      direction: { x: 0, z: 1 },
      length: 40,
      surfaceY: 18,
    } as unknown as BooleanSubtractModifier
    const migrated = normalizeTunnelModifier(legacy)
    expect(migrated.shape).toBe('capsule-path')
    expect(migrated.portals[0]).toMatchObject({ x: 10, y: 18, z: 0 })
    expect(migrated.portals[1]).toMatchObject({ x: 10, y: 18, z: 40 })
    expect(migrated.depth).toBe(14)
  })
})
