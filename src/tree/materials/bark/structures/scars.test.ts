import { describe, expect, it } from 'vitest'
import { sampleScars } from './scars'

/** Samples the whole tile on a grid, returning every scar reading. */
function survey(incidence: number, steps = 220) {
  const tissue: number[] = []
  const relief: number[] = []
  for (let y = 0; y < steps; y += 1) {
    for (let x = 0; x < steps; x += 1) {
      const sample = sampleScars(x / steps, y / steps, 3, 4, 4242, incidence)
      tissue.push(sample.tissue)
      relief.push(sample.relief)
    }
  }
  return { tissue, relief }
}

describe('bark scars', () => {
  it('does nothing at all when a species carries none', () => {
    const { tissue, relief } = survey(0)
    expect(Math.max(...tissue)).toBe(0)
    expect(Math.max(...relief)).toBe(0)
  })

  it('stays sparse: a few large sockets, not a field of pockmarks', () => {
    const { tissue } = survey(0.5)
    const covered = tissue.filter((value) => value > 0.5).length / tissue.length
    expect(covered).toBeGreaterThan(0.002)
    expect(covered).toBeLessThan(0.14)
  })

  it('raises a collar around a sunken face', () => {
    // The signature of a healed socket, and the reason it reads as a socket
    // rather than as a stain: wound wood stands proud of the bark around a
    // centre that has pulled in.
    const { relief } = survey(0.7)
    expect(Math.max(...relief)).toBeGreaterThan(0.2)
    expect(Math.min(...relief)).toBeLessThan(-0.15)
  })

  it('wraps at both tile seams', () => {
    for (let step = 0; step < 64; step += 1) {
      const v = step / 64
      const left = sampleScars(0, v, 3, 4, 4242, 0.8)
      const right = sampleScars(1, v, 3, 4, 4242, 0.8)
      expect(Math.abs(left.tissue - right.tissue)).toBeLessThan(1e-6)
      expect(Math.abs(left.relief - right.relief)).toBeLessThan(1e-6)
      const u = step / 64
      const top = sampleScars(u, 0, 3, 4, 4242, 0.8)
      const bottom = sampleScars(u, 1, 3, 4, 4242, 0.8)
      expect(Math.abs(top.tissue - bottom.tissue)).toBeLessThan(1e-6)
      expect(Math.abs(top.relief - bottom.relief)).toBeLessThan(1e-6)
    }
  })

  it('is deterministic for a seed', () => {
    const first = survey(0.6).relief
    const second = survey(0.6).relief
    expect(first).toEqual(second)
  })
})
