import { describe, expect, it } from 'vitest'
import { makeBladeShape } from './blade'
import { leafProfileFor } from './profiles'

const oak = leafProfileFor('ancient-oak')

/** Half-widths sampled along one side of a blade. */
function outline(variation: number, side: number, steps = 400): number[] {
  const shape = makeBladeShape(oak, variation, oak.aspect)
  return Array.from({ length: steps + 1 }, (_, index) =>
    shape.halfWidth(index / steps, side))
}

describe('lobed blade outline', () => {
  it('closes at both ends so the cutout needs no straight cut', () => {
    for (const variation of [0.05, 0.35, 0.62, 0.94]) {
      const shape = makeBladeShape(oak, variation, oak.aspect)
      for (const side of [-1, 1]) {
        expect(shape.halfWidth(0, side)).toBeLessThan(oak.aspect * 0.05)
        expect(shape.halfWidth(1.02, side)).toBeLessThan(oak.aspect * 0.05)
      }
    }
  })

  it('carries basal auricles rather than tapering the base to a point', () => {
    // A spearhead base rises monotonically. A real oak flares into two small
    // ears, pinches above them, then widens into the lamina — so the profile
    // must fall somewhere in the lowest fifth of the blade.
    for (const variation of [0.2, 0.5, 0.8]) {
      const shape = makeBladeShape(oak, variation, oak.aspect)
      const low = Array.from({ length: 40 }, (_, index) =>
        shape.halfWidth((index / 40) * 0.2, 1))
      const dips = low.some((value, index) => index > 0 && value < low[index - 1]!)
      expect(dips).toBe(true)
    }
  })

  it('keeps a blunt apex instead of tapering to a willow point', () => {
    // Measured as the width still present a tenth of the way down from the tip.
    // A pointed apex collapses long before that.
    for (const variation of [0.1, 0.45, 0.9]) {
      const shape = makeBladeShape(oak, variation, oak.aspect)
      const nearTip = Math.max(shape.halfWidth(0.9, 1), shape.halfWidth(0.9, -1))
      const widest = Math.max(...outline(variation, 1), ...outline(variation, -1))
      expect(nearTip / widest).toBeGreaterThan(0.3)
    }
  })

  it('cuts sinuses deep enough to read as lobes, not as serrations', () => {
    for (const variation of [0.15, 0.5, 0.85]) {
      const values = outline(variation, 1).slice(80, 360)
      const widest = Math.max(...values)
      // Find the deepest interior minimum flanked by taller neighbours.
      let deepest = widest
      for (let index = 1; index < values.length - 1; index += 1) {
        const value = values[index]!
        if (value < values[index - 1]! && value < values[index + 1]!) {
          deepest = Math.min(deepest, value)
        }
      }
      expect(deepest).toBeLessThan(widest * 0.78)
    }
  })

  it('never mirrors its two halves', () => {
    for (const variation of [0.11, 0.4, 0.73, 0.99]) {
      const left = outline(variation, -1)
      const right = outline(variation, 1)
      const difference = left.reduce(
        (total, value, index) => total + Math.abs(value - right[index]!), 0,
      ) / left.length
      expect(difference).toBeGreaterThan(oak.aspect * 0.02)
    }
  })

  it('stays smooth: no cusp steeper than a blade this size can resolve', () => {
    // A rectified sine or a fractional power on the lobe train puts a V-notch
    // at every sinus, which is both the wrong species and the thing that
    // aliases into shimmer once the card is minified.
    for (const variation of [0.25, 0.6, 0.88]) {
      const values = outline(variation, 1, 2000)
      let steepest = 0
      for (let index = 1; index < values.length; index += 1) {
        steepest = Math.max(steepest, Math.abs(values[index]! - values[index - 1]!))
      }
      // Per 1/2000 of blade length; a cusp shows up as a step far beyond this.
      expect(steepest).toBeLessThan(oak.aspect * 0.02)
    }
  })
})

describe('venation', () => {
  it('runs its secondaries out to the lobe apices', () => {
    const shape = makeBladeShape(oak, 0.42, oak.aspect)
    // Somewhere out along the lamina, away from the midrib, a secondary must
    // actually be present — veins that only exist near the rib read as a
    // printed pattern rather than as the structure holding the blade open.
    let peak = 0
    for (let step = 0; step <= 200; step += 1) {
      const u = 0.2 + (step / 200) * 0.6
      const half = shape.halfWidth(u, 1)
      for (let across = 0.3; across < 0.9; across += 0.05) {
        peak = Math.max(peak, shape.veins(u, half * across, 1).lateral)
      }
    }
    expect(peak).toBeGreaterThan(0.5)
  })

  it('puts the midrib on the midline and nowhere else', () => {
    const shape = makeBladeShape(oak, 0.42, oak.aspect)
    expect(shape.veins(0.5, 0, 1).midrib).toBeGreaterThan(0.9)
    expect(shape.veins(0.5, oak.aspect * 0.2, 1).midrib).toBeLessThan(0.05)
  })
})
