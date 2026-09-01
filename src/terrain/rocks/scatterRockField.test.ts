import { describe, expect, it } from 'vitest'
import {
  SCATTER_ROCK_BANDS,
  placeScatterRockBand,
  placeScatterRocks,
  type ScatterRockSurface,
} from './scatterRockField'

/** A hillside: flat basin, a steep face, and a flat bench on top. */
const hillside: ScatterRockSurface = {
  height(x: number) {
    if (x < 40) return 0
    if (x > 70) return 60
    return ((x - 40) / 30) * 60
  },
}

const flat: ScatterRockSurface = { height: () => 0 }

describe('placeScatterRockBand', () => {
  it('puts nothing on ground with no supply above it', () => {
    for (const band of SCATTER_ROCK_BANDS) {
      const instances = placeScatterRockBand(band, 0, 0, flat, 5)
      expect(instances).toHaveLength(0)
    }
  })

  it('concentrates rock below the break in slope, not on the bench above it', () => {
    const band = SCATTER_ROCK_BANDS[2]!
    const instances = placeScatterRockBand(band, 55, 0, hillside, 5)
    expect(instances.length).toBeGreaterThan(0)
    const belowBreak = instances.filter((one) => one.x < 70).length
    const onBench = instances.filter((one) => one.x > 78).length
    expect(belowBreak).toBeGreaterThan(onBench)
  })

  it('stays inside its own range', () => {
    const band = SCATTER_ROCK_BANDS[1]!
    for (const one of placeScatterRockBand(band, 55, 10, hillside, 5)) {
      const distance = Math.hypot(one.x - 55, one.z - 10)
      expect(distance).toBeLessThanOrEqual(band.range + 1e-6)
    }
  })

  it('beds each rock into the ground rather than on top of it', () => {
    const band = SCATTER_ROCK_BANDS[2]!
    for (const one of placeScatterRockBand(band, 55, 0, hillside, 5)) {
      const ground = hillside.height(one.x, one.z)
      expect(one.y).toBeLessThan(ground)
      expect(ground - one.y).toBeCloseTo(one.scale * band.burial, 6)
    }
  })

  it('gives every rock a unit bedding normal and a size inside its band', () => {
    const band = SCATTER_ROCK_BANDS[2]!
    const instances = placeScatterRockBand(band, 55, 0, hillside, 5)
    expect(instances.length).toBeGreaterThan(0)
    for (const one of instances) {
      expect(Math.hypot(one.normalX, one.normalY, one.normalZ)).toBeCloseTo(1, 6)
      expect(one.scale).toBeGreaterThanOrEqual(band.size[0])
      expect(one.scale).toBeLessThanOrEqual(band.size[1])
      expect(one.variant).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps a slot on the same rock as the camera window moves', () => {
    // Placement is anchored to a world lattice, not to the camera, so panning
    // must not reshuffle the field.
    const band = SCATTER_ROCK_BANDS[2]!
    const first = placeScatterRockBand(band, 55, 0, hillside, 5)
    const second = placeScatterRockBand(band, 61, 4, hillside, 5)
    const key = (one: { x: number; z: number }) =>
      `${one.x.toFixed(4)}:${one.z.toFixed(4)}`
    const shared = new Set(second.map(key))
    const survivors = first.filter((one) => shared.has(key(one)))
    expect(survivors.length).toBeGreaterThan(first.length * 0.5)
    for (const one of survivors) {
      const match = second.find((other) => key(other) === key(one))!
      expect(match.scale).toBeCloseTo(one.scale, 9)
      expect(match.yaw).toBeCloseTo(one.yaw, 9)
      expect(match.variant).toBe(one.variant)
    }
  })

  it('drops anything below the water line', () => {
    const drowned: ScatterRockSurface = { ...hillside, waterLevel: 30 }
    for (const one of placeScatterRockBand(
      SCATTER_ROCK_BANDS[2]!,
      55,
      0,
      drowned,
      5,
    )) {
      expect(hillside.height(one.x, one.z)).toBeGreaterThan(30)
    }
  })

  it('sizes the whole field for the hardware it has to run on', () => {
    const placements = placeScatterRocks(55, 0, hillside, 5)
    const total = placements.reduce(
      (sum, placement) => sum + placement.instances.length,
      0,
    )
    // The near ring is a few hundred instances, not a few thousand. See the
    // per-band ranges: this is the number that has to stay affordable.
    expect(total).toBeGreaterThan(20)
    expect(total).toBeLessThan(2_000)
  })
})
