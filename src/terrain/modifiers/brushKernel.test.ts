import { describe, expect, it } from 'vitest'
import {
  applyBrushDab,
  brushProfile,
  BRUSH_DEPTH_PER_RADIUS,
  MAX_STROKE_DISPLACEMENT_PER_RADIUS,
  MAX_OUTWARD_SLIDE_PER_RADIUS,
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
      applyBrushDab(point, params({ radius }), upward, { ...point })
      expect(point.y).toBeCloseTo(radius * BRUSH_DEPTH_PER_RADIUS, 6)
    }
  })

  it('scales linearly with strength and with dab weight', () => {
    const full = { x: 0, y: 0, z: 0 }
    applyBrushDab(full, params(), upward, { ...full })
    const half = { x: 0, y: 0, z: 0 }
    applyBrushDab(half, params({ strength: 0.5 }), upward, { ...half })
    expect(half.y).toBeCloseTo(full.y * 0.5, 6)

    const light = { x: 0, y: 0, z: 0 }
    applyBrushDab(light, params(), { ...upward, weight: 0.25 }, { ...light })
    expect(light.y).toBeCloseTo(full.y * 0.25, 6)
  })

  it('lowers by the same amount it raises', () => {
    const raised = { x: 0, y: 0, z: 0 }
    applyBrushDab(raised, params({ mode: 'raise' }), upward, { ...raised })
    const lowered = { x: 0, y: 0, z: 0 }
    applyBrushDab(lowered, params({ mode: 'lower' }), upward, { ...lowered })
    expect(lowered.y).toBeCloseTo(-raised.y, 6)
  })

  it('leaves points outside the footprint untouched', () => {
    const point = { x: 10, y: 0, z: 0 }
    applyBrushDab(point, params(), upward, { ...point })
    expect(point).toEqual({ x: 10, y: 0, z: 0 })
  })

  it('builds clay toward a crest instead of drilling a spike when held', () => {
    const point = { x: 0, y: 0, z: 0 }
    const clay = params({ mode: 'clay' })
    const anchor = { ...point }
    for (let dab = 0; dab < 200; dab += 1) {
      applyBrushDab(point, clay, { ...upward, weight: 0.1 }, anchor)
    }
    // Held flow converges on the crest the strips build toward rather than
    // running away with the surface.
    expect(point.y).toBeGreaterThan(10 * BRUSH_DEPTH_PER_RADIUS * 0.9)
    expect(point.y).toBeLessThan(10 * BRUSH_DEPTH_PER_RADIUS * 1.05)
  })

  it('settles a held raise at its target depth instead of running away', () => {
    const point = { x: 0, y: 0, z: 0 }
    const anchor = { ...point }
    const raise = params({ mode: 'raise' })
    for (let dab = 0; dab < 400; dab += 1) {
      applyBrushDab(point, raise, { ...upward, weight: 0.25 }, anchor)
    }
    // Holding the pointer used to integrate without limit and drive the surface
    // out to roughly a full brush radius, spiking it far past what the
    // footprint can taper back down. One stroke now converges.
    expect(point.y).toBeCloseTo(10 * BRUSH_DEPTH_PER_RADIUS, 4)
  })

  it('does not grant more growth when its dabs climb the surface it is raising', () => {
    // The editor raycasts each dab against the previewed geometry, so a held
    // brush reports dab planes that climb the mound it is building. Measuring
    // convergence from the dab plane let every pixel of pointer jitter reopen a
    // full growth allowance: the surface grew, stopped, grew again, and
    // eventually ran far past what its footprint could taper back down.
    const point = { x: 0, y: 0, z: 0 }
    const anchor = { ...point }
    const raise = params({ mode: 'raise' })
    for (let dab = 0; dab < 300; dab += 1) {
      applyBrushDab(
        point,
        raise,
        // Each dab is sampled from wherever the surface now is.
        { ...upward, y: point.y, weight: 0.25 },
        anchor,
      )
    }
    expect(point.y).toBeCloseTo(10 * BRUSH_DEPTH_PER_RADIUS, 4)
  })

  it('keeps building while held when build-up is continuous', () => {
    const held = (accumulate: boolean) => {
      const point = { x: 0, y: 0, z: 0 }
      const anchor = { ...point }
      for (let dab = 0; dab < 60; dab += 1) {
        applyBrushDab(
          point,
          params({ mode: 'raise', accumulate }),
          { ...upward, weight: 0.25 },
          anchor,
        )
      }
      return point.y
    }
    // Per stroke settles on the depth the profile sets; continuous does not,
    // which is the freer feel and the one that can outrun the triangulation.
    expect(held(false)).toBeCloseTo(10 * BRUSH_DEPTH_PER_RADIUS, 4)
    expect(held(true)).toBeGreaterThan(held(false) * 3)
  })

  it('bounds sideways travel even when build-up is continuous', () => {
    const oblique: BrushKernelSample = {
      ...upward,
      normalX: 0.8,
      normalY: 0.6,
      normalZ: 0,
      weight: 0.5,
    }
    const point = { x: 0, y: 0, z: 0 }
    const anchor = { ...point }
    for (let dab = 0; dab < 500; dab += 1) {
      applyBrushDab(
        point,
        params({ mode: 'raise', domain: 'mesh', accumulate: true }),
        oblique,
        anchor,
      )
    }
    // Opting into continuous build-up frees growth along the normal, never the
    // sideways travel that turns a section's triangles inside out.
    expect(Math.hypot(point.x, point.z)).toBeLessThanOrEqual(
      10 * MAX_OUTWARD_SLIDE_PER_RADIUS + 1e-6,
    )
    // Growth along the normal is free until the point simply leaves the
    // footprint, which is a bound the brush geometry imposes on its own.
    expect(point.y).toBeGreaterThan(10 * BRUSH_DEPTH_PER_RADIUS * 2)
  })

  it('bounds what one stroke can do, however many dabs it is given', () => {
    // A dab whose normal is mostly sideways, repeated far past any sane stroke.
    const oblique: BrushKernelSample = {
      ...upward,
      normalX: 0.8,
      normalY: 0.6,
      normalZ: 0,
      weight: 0.5,
    }
    for (const mode of ['raise', 'lower', 'pinch', 'noise', 'clay'] as const) {
      const point = { x: 0, y: 3, z: 0 }
      const anchor = { ...point }
      for (let dab = 0; dab < 500; dab += 1) {
        applyBrushDab(point, params({ mode, domain: 'mesh' }), oblique, anchor)
      }
      const lateral = Math.hypot(point.x - anchor.x, point.z - anchor.z)
      const total = Math.hypot(
        point.x - anchor.x,
        point.y - anchor.y,
        point.z - anchor.z,
      )
      // Sideways travel is what turns a section's triangles inside out, so it
      // is held well inside the footprint no matter what the stroke does.
      expect(lateral).toBeLessThanOrEqual(10 * MAX_OUTWARD_SLIDE_PER_RADIUS + 1e-6)
      expect(total).toBeLessThanOrEqual(10 * MAX_STROKE_DISPLACEMENT_PER_RADIUS + 1e-6)
    }
  })

  it('sharpens relief about the dab plane when pinching, without sliding sideways', () => {
    const params3d = params({ mode: 'pinch', domain: 'mesh' })
    const ridge = { x: 0, y: 3, z: 0 }
    applyBrushDab(ridge, params3d, upward, { ...ridge })
    expect(ridge.y).toBeGreaterThan(3)
    expect(ridge.x).toBe(0)
    expect(ridge.z).toBe(0)

    const crease = { x: 0, y: -3, z: 0 }
    applyBrushDab(crease, params3d, upward, { ...crease })
    expect(crease.y).toBeLessThan(-3)

    // Continuous through the crossing: two vertices either side of it must not
    // be flung in opposite directions.
    const onPlane = { x: 0, y: 0, z: 0 }
    applyBrushDab(onPlane, params3d, upward, { ...onPlane })
    expect(onPlane.y).toBeCloseTo(0, 6)
  })

  it('keeps noise breakup shallower than its own wavelength', () => {
    // A step per noise cell used to let neighbouring vertices jump opposite
    // ways by metres, which folds the surface between them.
    let deepest = 0
    for (let step = 0; step < 400; step += 1) {
      const point = { x: step * 0.37, y: 0, z: step * 0.11 }
      const anchor = { ...point }
      applyBrushDab(point, params({ mode: 'noise', noiseScale: 3 }), upward, anchor)
      deepest = Math.max(deepest, Math.abs(point.y - anchor.y))
    }
    expect(deepest).toBeGreaterThan(0)
    expect(deepest).toBeLessThanOrEqual(3 * 0.45 + 1e-6)
  })

  it('relaxes toward the sampled surface when smoothing, from either side', () => {
    const above = { x: 0, y: 6, z: 0 }
    applyBrushDab(above, params({ mode: 'smooth' }), upward, { ...above })
    expect(above.y).toBeLessThan(6)
    expect(above.y).toBeGreaterThan(0)

    const below = { x: 0, y: -6, z: 0 }
    applyBrushDab(below, params({ mode: 'smooth' }), upward, { ...below })
    expect(below.y).toBeGreaterThan(-6)
    expect(below.y).toBeLessThan(0)
  })

  it('scrapes material above the sampled plane and leaves hollows alone', () => {
    const ridge = { x: 0, y: 4, z: 0 }
    applyBrushDab(ridge, params({ mode: 'scrape' }), upward, { ...ridge })
    expect(ridge.y).toBeCloseTo(0, 6)

    const hollow = { x: 0, y: -4, z: 0 }
    applyBrushDab(hollow, params({ mode: 'scrape' }), upward, { ...hollow })
    expect(hollow.y).toBeCloseTo(-4, 6)
  })
})
