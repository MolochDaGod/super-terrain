import { describe, expect, it } from 'vitest'
import { packBarkAmbientOcclusion } from './ambientOcclusion'

describe('packBarkAmbientOcclusion', () => {
  it('leaves a flat exposed surface fully open to ambient light', () => {
    const width = 32
    const height = 32
    const heights = new Float32Array(width * height).fill(0.5)
    const furrows = new Float32Array(width * height)
    const surface = new Uint8Array(width * height * 4)

    packBarkAmbientOcclusion(heights, furrows, surface, width, height)

    for (let index = 0; index < width * height; index += 1) {
      expect(surface[index * 4]).toBe(255)
    }
  })

  it('darkens a sheltered fissure deterministically without touching roughness', () => {
    const width = 32
    const height = 32
    const heights = new Float32Array(width * height).fill(0.8)
    const furrows = new Float32Array(width * height)
    const fissure = 16 * width + 16
    heights[fissure] = 0.1
    furrows[fissure] = 1
    const first = new Uint8Array(width * height * 4).fill(173)
    const second = Uint8Array.from(first)

    packBarkAmbientOcclusion(heights, furrows, first, width, height)
    packBarkAmbientOcclusion(heights, furrows, second, width, height)

    expect(first).toEqual(second)
    expect(first[fissure * 4]).toBeLessThan(200)
    expect(first[fissure * 4 + 1]).toBe(173)
    expect(first[fissure * 4 + 2]).toBe(173)
  })
})
