import { describe, expect, it } from 'vitest'
import { resizeRgbaNearest } from './resample'

describe('procedural texture preview resizing', () => {
  it('expands RGBA pixels to the fixed GPU allocation size', () => {
    const source = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8,
      9, 10, 11, 12, 13, 14, 15, 16,
    ])

    const resized = resizeRgbaNearest(source, 2, 4)
    const pixel = (x: number, y: number) => [
      ...resized.subarray((y * 4 + x) * 4, (y * 4 + x + 1) * 4),
    ]

    expect(pixel(0, 0)).toEqual([1, 2, 3, 4])
    expect(pixel(1, 1)).toEqual([1, 2, 3, 4])
    expect(pixel(2, 0)).toEqual([5, 6, 7, 8])
    expect(pixel(0, 2)).toEqual([9, 10, 11, 12])
    expect(pixel(3, 3)).toEqual([13, 14, 15, 16])
  })

  it('does not copy a full-resolution bake', () => {
    const source = new Uint8Array([1, 2, 3, 4])
    expect(resizeRgbaNearest(source, 1, 1)).toBe(source)
  })
})
