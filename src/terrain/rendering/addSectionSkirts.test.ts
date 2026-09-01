import { describe, expect, it } from 'vitest'
import { addSectionSkirts } from './addSectionSkirts'

describe('section skirts', () => {
  it('adds vertical faces to ownership-plane edges', () => {
    const result = addSectionSkirts(
      {
        positions: new Float32Array([
          0, 2, 0,
          8, 3, 0,
          0, 4, 8,
          8, 5, 8,
        ]),
        normals: new Float32Array([
          0, 1, 0,
          0, 1, 0,
          0, 1, 0,
          0, 1, 0,
        ]),
        colors: new Float32Array([
          1, 1, 1,
          1, 1, 1,
          1, 1, 1,
          1, 1, 1,
        ]),
        indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
      },
      8,
    )
    expect(result.indices.length).toBe(6 + 4 * 6)
    expect(result.positions.length).toBe(12 + 4 * 4 * 3)
    // The skirt hangs below the lowest boundary vertex by a depth sized from
    // this LOD's own sample spacing, because that is what bounds how far a
    // neighbour one level coarser can disagree with it. One quad per side here,
    // so the spacing is the whole eight-metre section.
    expect(Math.min(...result.positions.filter((_, index) => index % 3 === 1)))
      .toBeCloseTo(2 - (3 + 8 * 2.5), 4)
  })

  it('hangs a shallower skirt off a finer grid', () => {
    // Same section, four quads per side instead of one. A finer LOD cannot
    // disagree with its neighbour by as much, so it must not reach as far: a
    // skirt is only invisible while the ground in front of it is higher than
    // its lower edge, and the near sections are where that fails most visibly.
    const resolution = 4
    const stride = resolution + 1
    const positions: number[] = []
    const normals: number[] = []
    const colors: number[] = []
    for (let z = 0; z <= resolution; z += 1) {
      for (let x = 0; x <= resolution; x += 1) {
        positions.push((x / resolution) * 8, 2, (z / resolution) * 8)
        normals.push(0, 1, 0)
        colors.push(1, 1, 1)
      }
    }
    const indices: number[] = []
    for (let z = 0; z < resolution; z += 1) {
      for (let x = 0; x < resolution; x += 1) {
        const a = z * stride + x
        indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1)
      }
    }
    const fine = addSectionSkirts(
      {
        positions: Float32Array.from(positions),
        normals: Float32Array.from(normals),
        colors: Float32Array.from(colors),
        indices: Uint32Array.from(indices),
      },
      8,
    )
    expect(Math.min(...fine.positions.filter((_, index) => index % 3 === 1)))
      .toBeCloseTo(2 - (3 + (8 / resolution) * 2.5), 4)
  })

  it('does not skirt an intentional open edge away from section planes', () => {
    const positions = new Float32Array([2, 1, 2, 4, 1, 2, 3, 1, 4])
    const indices = new Uint32Array([0, 1, 2])
    const result = addSectionSkirts(
      {
        positions,
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
        indices,
      },
      8,
    )
    expect(result.positions).toBe(positions)
    expect(result.indices).toBe(indices)
  })
})
