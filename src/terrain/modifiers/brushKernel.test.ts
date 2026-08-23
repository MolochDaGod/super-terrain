import { describe, expect, it } from 'vitest'
import {
  applyBrushDab,
  brushProfile,
  BRUSH_DEPTH_PER_RADIUS,
  type BrushKernelParams,
  type BrushKernelSample,
} from './brushKernel'

const upward: BrushKernelSample = {
  x: 0,
  y: 0,
  z: 0,
  normalX: 0,
  normalY: 1,
  normalZ: 0,
  weight: 1,
}

function params(overrides: Partial<BrushKernelParams> = {}): BrushKernelParams {
  return {
    mode: 'raise',
    domain: 'heightfield',
    radius: 10,
    strength: 1,
    falloff: 0.5,
    ...overrides,
  }
}

describe('brush profile', () => {
  it('reads as softness: zero falloff moves the footprint as one flat disc', () => {
    expect(brushProfile(0, 10, 0)).toBe(1)
    expect(brushProfile(8.9, 10, 0)).toBe(1)
    expect(brushProfile(10, 10, 0)).toBe(0)
  })

  it('tapers from the centre when fully soft', () => {
    const centre = brushProfile(0, 10, 1)
    const middle = brushProfile(5, 10, 1)
    const rim = brushProfile(9.5, 10, 1)
    expect(centre).toBe(1)
    expect(middle).toBeLessThan(centre)
    expect(rim).toBeLessThan(middle)
    expect(brushProfile(10, 10, 1)).toBe(0)
  })
})

describe('brush dabs', () => {
  it('deposits a fixed fraction of the brush radius, so a wide brush moves more', () => {
    for (const radius of [4, 22, 60]) {
      const point = { x: 0, y: 0, z: 0 }
      applyBrushDab(point, params({ radius }), upward)
      expect(point.y).toBeCloseTo(radius * BRUSH_DEPTH_PER_RADIUS, 6)
    }
  })

  it('scales linearly with strength and with dab weight', () => {
    const full = { x: 0, y: 0, z: 0 }
    applyBrushDab(full, params(), upward)
    const half = { x: 0, y: 0, z: 0 }
    applyBrushDab(half, params({ strength: 0.5 }), upward)
    expect(half.y).toBeCloseTo(full.y * 0.5, 6)

    const light = { x: 0, y: 0, z: 0 }
    applyBrushDab(light, params(), { ...upward, weight: 0.25 })
    expect(light.y).toBeCloseTo(full.y * 0.25, 6)
  })

  it('lowers by the same amount it raises', () => {
    const raised = { x: 0, y: 0, z: 0 }
    applyBrushDab(raised, params({ mode: 'raise' }), upward)
    const lowered = { x: 0, y: 0, z: 0 }
    applyBrushDab(lowered, params({ mode: 'lower' }), upward)
    expect(lowered.y).toBeCloseTo(-raised.y, 6)
  })

  it('leaves points outside the footprint untouched', () => {
    const point = { x: 10, y: 0, z: 0 }
    applyBrushDab(point, params(), upward)
    expect(point).toEqual({ x: 10, y: 0, z: 0 })
  })

  it('builds clay toward a crest instead of drilling a spike when held', () => {
    const point = { x: 0, y: 0, z: 0 }
    const clay = params({ mode: 'clay' })
    for (let dab = 0; dab < 200; dab += 1) {
      applyBrushDab(point, clay, { ...upward, weight: 0.1 })
    }
    // Held flow converges on the crest the strips build toward rather than
    // running away with the surface.
    expect(point.y).toBeGreaterThan(10 * BRUSH_DEPTH_PER_RADIUS * 0.9)
    expect(point.y).toBeLessThan(10 * BRUSH_DEPTH_PER_RADIUS * 1.05)
  })

  it('relaxes toward the sampled surface when smoothing, from either side', () => {
    const above = { x: 0, y: 6, z: 0 }
    applyBrushDab(above, params({ mode: 'smooth' }), upward)
    expect(above.y).toBeLessThan(6)
    expect(above.y).toBeGreaterThan(0)

    const below = { x: 0, y: -6, z: 0 }
    applyBrushDab(below, params({ mode: 'smooth' }), upward)
    expect(below.y).toBeGreaterThan(-6)
    expect(below.y).toBeLessThan(0)
  })

  it('scrapes material above the sampled plane and leaves hollows alone', () => {
    const ridge = { x: 0, y: 4, z: 0 }
    applyBrushDab(ridge, params({ mode: 'scrape' }), upward)
    expect(ridge.y).toBeCloseTo(0, 6)

    const hollow = { x: 0, y: -4, z: 0 }
    applyBrushDab(hollow, params({ mode: 'scrape' }), upward)
    expect(hollow.y).toBeCloseTo(-4, 6)
  })
})
