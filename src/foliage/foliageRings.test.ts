import { describe, expect, it } from 'vitest'
import {
  FOLIAGE_INSTANCE_CAPACITY,
  FOLIAGE_INSTANCED_RANGE,
  FOLIAGE_RINGS,
  FOLIAGE_RING_OFFSETS,
} from './FoliagePopulation'

/**
 * The blades per square metre the whole table is calibrated against: the near
 * ring's five blades in a 0.22 m cell. Every other ring compensates for its
 * own coarser spacing with a `widthBoost` of `reference / its own density`.
 */
const REFERENCE_BLADE_DENSITY = 5 / 0.22 ** 2

describe('FOLIAGE_RINGS', () => {
  it('gives every ring a lattice that spans its own outer radius', () => {
    // A ring places candidates on a grid×cell lattice centred on the camera, so
    // it physically cannot put a clump beyond half that span. Raising `outer`
    // past it does nothing at all — the band just ends where the lattice does —
    // and the failure is silent, which is what makes it worth a test.
    for (const ring of FOLIAGE_RINGS) {
      const reach = (ring.grid * ring.cell) / 2
      expect(reach, `${ring.name} lattice`).toBeGreaterThanOrEqual(ring.outer)
    }
  })

  it('overlaps each ring with the previous one exactly', () => {
    // Each ring's inner fade band must be the previous ring's outer fade band,
    // so the two shares sum to one across the overlap. Anything else leaves a
    // ring of thin or doubled cover at a fixed distance from the camera, which
    // follows the viewer around and is spotted instantly.
    for (let index = 1; index < FOLIAGE_RINGS.length; index += 1) {
      const previous = FOLIAGE_RINGS[index - 1]!
      const ring = FOLIAGE_RINGS[index]!
      expect(ring.inner, `${ring.name} inner`).toBeCloseTo(
        previous.outer - previous.fadeOut,
        5,
      )
      expect(ring.fadeIn, `${ring.name} fadeIn`).toBeCloseTo(previous.fadeOut, 5)
    }
  })

  it('holds one sward density across every ring', () => {
    // What the eye reads as how thick the sward is, is blades per square metre
    // times blade width. A coarser ring pays its shortfall back in width; this
    // is that arithmetic, which the comment on each ring states and which is
    // otherwise only checkable by rebuilding the scene and looking at it.
    for (const ring of FOLIAGE_RINGS) {
      const density = ring.blades / ring.cell ** 2
      const implied = REFERENCE_BLADE_DENSITY / density
      expect(ring.widthBoost, `${ring.name} widthBoost`).toBeCloseTo(implied, 1)
    }
  })

  it('runs outward without a gap', () => {
    expect(FOLIAGE_RINGS[0]!.inner).toBe(0)
    for (let index = 1; index < FOLIAGE_RINGS.length; index += 1) {
      expect(FOLIAGE_RINGS[index]!.inner).toBeLessThan(
        FOLIAGE_RINGS[index - 1]!.outer,
      )
      expect(FOLIAGE_RINGS[index]!.outer).toBeGreaterThan(
        FOLIAGE_RINGS[index - 1]!.outer,
      )
    }
    expect(FOLIAGE_INSTANCED_RANGE).toBe(
      FOLIAGE_RINGS[FOLIAGE_RINGS.length - 1]!.outer,
    )
  })

  it('gives every ring a disjoint slice of the instance buffer', () => {
    let next = 0
    FOLIAGE_RINGS.forEach((ring, index) => {
      expect(FOLIAGE_RING_OFFSETS[index]).toBe(next)
      next += ring.grid * ring.grid
    })
    expect(FOLIAGE_INSTANCE_CAPACITY).toBe(next)
  })
})
