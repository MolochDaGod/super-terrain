import { describe, expect, it } from 'vitest'
import {
  expandBounds,
  parseSectionId,
  sectionBounds,
  sectionId,
  unionBounds,
  worldToSection,
} from './bounds'

describe('section addressing', () => {
  it('uses floor semantics for negative world coordinates', () => {
    expect(worldToSection(0, 0, 128)).toEqual({ x: 0, z: 0 })
    expect(worldToSection(127.99, -0.01, 128)).toEqual({ x: 0, z: -1 })
    expect(worldToSection(-128, -128.01, 128)).toEqual({ x: -1, z: -2 })
  })

  it('round-trips integer section keys', () => {
    const key = { x: -17, z: 204 }
    expect(parseSectionId(sectionId(key))).toEqual(key)
  })

  it('creates and combines exact world bounds', () => {
    const first = sectionBounds({ x: -1, z: 2 }, 128, -10, 50)
    expect(first.min).toEqual({ x: -128, y: -10, z: 256 })
    expect(first.max).toEqual({ x: 0, y: 50, z: 384 })
    const expanded = expandBounds(first, 2)
    expect(expanded.min.x).toBe(-130)
    expect(unionBounds(first, { min: { x: -5, y: -20, z: 250 }, max: { x: 4, y: 8, z: 260 } }).max.x).toBe(4)
  })
})
