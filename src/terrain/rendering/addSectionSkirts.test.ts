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
    expect(Math.min(...result.positions.filter((_, index) => index % 3 === 1))).toBe(0.5)
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
