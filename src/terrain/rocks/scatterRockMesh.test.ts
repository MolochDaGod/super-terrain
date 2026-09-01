import { describe, expect, it } from 'vitest'
import {
  createScatterRockMesh,
  scatterRockSeed,
  scatterRockWavelength,
} from './scatterRockMesh'
import { graniteMassingOfSeed } from './types'

describe('createScatterRockMesh', () => {
  it('produces a closed-looking mesh standing on y = 0', () => {
    const rock = createScatterRockMesh({ seed: scatterRockSeed(7), subdivisions: 3 })
    expect(rock.triangles).toBe(1_280)
    expect(rock.positions.length).toBe(1_280 * 9)
    expect(rock.normals.length).toBe(1_280 * 9)

    let minimumY = Infinity
    for (let offset = 1; offset < rock.positions.length; offset += 3) {
      minimumY = Math.min(minimumY, rock.positions[offset]!)
    }
    expect(minimumY).toBeCloseTo(0, 5)
    expect(rock.extent[1]).toBeGreaterThan(0.2)
  })

  it('gives every vertex a unit normal', () => {
    const rock = createScatterRockMesh({ seed: scatterRockSeed(21), subdivisions: 2 })
    for (let offset = 0; offset < rock.normals.length; offset += 3) {
      const length = Math.hypot(
        rock.normals[offset]!,
        rock.normals[offset + 1]!,
        rock.normals[offset + 2]!,
      )
      expect(length).toBeCloseTo(1, 4)
    }
  })

  it('never selects the genus-one formation a radial solve cannot represent', () => {
    for (let requested = 0; requested < 200; requested += 1) {
      expect(graniteMassingOfSeed(scatterRockSeed(requested))).not.toBe('arch')
    }
  })

  it('varies its silhouette with the seed', () => {
    const first = createScatterRockMesh({ seed: scatterRockSeed(3), subdivisions: 2 })
    const second = createScatterRockMesh({ seed: scatterRockSeed(500), subdivisions: 2 })
    let differing = 0
    for (let offset = 0; offset < first.positions.length; offset += 1) {
      if (Math.abs(first.positions[offset]! - second.positions[offset]!) > 0.01) {
        differing += 1
      }
    }
    expect(differing).toBeGreaterThan(first.positions.length * 0.5)
  })

  it('drops noise bands the tessellation cannot carry', () => {
    // A coarse mesh must not be displaced by grain finer than its own edges;
    // doing so is what turns a low-poly rock into a spiky ball.
    expect(scatterRockWavelength(2)).toBeGreaterThan(scatterRockWavelength(4))
    const coarse = createScatterRockMesh({ seed: scatterRockSeed(11), subdivisions: 1 })
    let maximumRadius = 0
    let minimumRadius = Infinity
    for (let offset = 0; offset < coarse.positions.length; offset += 3) {
      const radius = Math.hypot(
        coarse.positions[offset]!,
        coarse.positions[offset + 2]!,
      )
      maximumRadius = Math.max(maximumRadius, radius)
      minimumRadius = Math.min(minimumRadius, radius)
    }
    expect(maximumRadius).toBeLessThan(2)
    expect(minimumRadius).toBeLessThan(maximumRadius)
  })

  it('builds a scatter-sized rock fast enough to bake a library at startup', () => {
    // The whole reason this exists. `generateGraniteRock` takes seconds per
    // rock; a library of variants has to cost milliseconds.
    createScatterRockMesh({ seed: scatterRockSeed(1), subdivisions: 3 })
    const started = performance.now()
    for (let index = 0; index < 8; index += 1) {
      createScatterRockMesh({ seed: scatterRockSeed(index * 37 + 5), subdivisions: 3 })
    }
    const perRock = (performance.now() - started) / 8
    expect(perRock).toBeLessThan(120)
  })
})
