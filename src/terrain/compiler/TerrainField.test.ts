import { describe, expect, it } from 'vitest'
import { terrainApronLift } from './TerrainField'

describe('mesh-patch terrain apron', () => {
  const apron = {
    center: { x: 20, y: 0, z: 30 },
    forward: { x: 1, y: 0, z: 0 },
    halfLength: 12,
    halfWidth: 5,
    falloff: 8,
    lift: 6,
  }

  it('raises the terrain under a patch and reaches zero outside its root', () => {
    expect(terrainApronLift(20, 30, apron)).toBeGreaterThan(5)
    expect(terrainApronLift(34, 30, apron)).toBeGreaterThan(0)
    expect(terrainApronLift(41, 30, apron)).toBe(0)
    expect(terrainApronLift(20, 44, apron)).toBe(0)
  })

  it('uses the authored orientation instead of an axis-aligned bounding box', () => {
    const diagonal = {
      ...apron,
      forward: { x: 1, y: 0, z: 1 },
    }
    expect(terrainApronLift(28, 38, diagonal)).toBeGreaterThan(0)
    expect(terrainApronLift(30, 20, diagonal)).toBe(0)
  })
})
