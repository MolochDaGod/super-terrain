import { describe, expect, it } from 'vitest'
import { bakeLeafSpray } from '../leafSprayAtlas'

const SIZE = 256
const spray = bakeLeafSpray(84721, 'ancient-oak', 1, SIZE)

/** Every texel the cutout keeps, as straight-alpha channel samples. */
function opaqueTexels() {
  const texels: { r: number; g: number; b: number; rough: number; trans: number; ao: number }[] = []
  for (let index = 0; index < SIZE * SIZE; index += 1) {
    if (spray.albedo[index * 4 + 3]! < 200) continue
    texels.push({
      r: spray.albedo[index * 4]! / 255,
      g: spray.albedo[index * 4 + 1]! / 255,
      b: spray.albedo[index * 4 + 2]! / 255,
      rough: spray.roughness[index * 4]! / 255,
      trans: spray.roughness[index * 4 + 1]! / 255,
      ao: spray.roughness[index * 4 + 2]! / 255,
    })
  }
  return texels
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!
}

describe('leaf spray atlas', () => {
  it('leaves sky through the card', () => {
    // A spray with no holes in it is a decal, and a crown built from decals
    // reads as cabbage however good the individual blades are.
    const covered = opaqueTexels().length / (SIZE * SIZE)
    expect(covered).toBeGreaterThan(0.08)
    expect(covered).toBeLessThan(0.45)
  })

  it('keeps content clear of the card border', () => {
    // A blade running off the edge is cut by a dead-straight line in the crown.
    for (let index = 0; index < SIZE; index += 1) {
      for (const edge of [
        index, // top row
        (SIZE - 1) * SIZE + index, // bottom row
        index * SIZE, // left column
        index * SIZE + SIZE - 1, // right column
      ]) {
        expect(spray.albedo[edge * 4 + 3]!).toBe(0)
      }
    }
  })

  it('dilates every channel past the cutout rim', () => {
    // Mip generation averages each channel against alpha independently, so a
    // transparent texel holding zero bleeds black into the edge of the blade
    // beside it. Checking albedo alone misses that undilated roughness makes
    // the same rim mirror-bright.
    let checked = 0
    for (let y = 1; y < SIZE - 1; y += 1) {
      for (let x = 1; x < SIZE - 1; x += 1) {
        const index = y * SIZE + x
        if (spray.albedo[index * 4 + 3]! !== 0) continue
        const neighbour = index + 1
        if (spray.albedo[neighbour * 4 + 3]! < 200) continue
        checked += 1
        expect(spray.albedo[index * 4 + 1]!).toBeGreaterThan(8)
        expect(spray.roughness[index * 4]!).toBeGreaterThan(8)
      }
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('survives minification without darkening or losing colour', () => {
    // A cutout atlas can look immaculate at mip 0 and collapse into a dark grey
    // haze by mip 3, which is the level most of a crown is sampled at.
    let level = { data: spray.albedo, size: SIZE }
    const full = weightedMean(level.data, level.size)
    for (let step = 0; step < 3; step += 1) level = downsample(level)
    const small = weightedMean(level.data, level.size)
    for (const channel of [0, 1, 2]) {
      expect(small[channel]!).toBeGreaterThan(full[channel]! * 0.85)
      expect(small[channel]!).toBeLessThan(full[channel]! * 1.15)
    }
  })

  it('is green, not autumnal', () => {
    const texels = opaqueTexels()
    const greenLead = texels.map((texel) => texel.g - texel.r)
    expect(percentile(greenLead, 0.1)).toBeGreaterThan(0.02)
    expect(percentile(greenLead, 0.5)).toBeGreaterThan(0.08)
  })

  it('spreads luminance widely enough to read as many leaves', () => {
    // One flat fill plus a normal map is the loudest plastic tell there is.
    const luminance = opaqueTexels().map(
      (texel) => 0.2126 * texel.r + 0.7152 * texel.g + 0.0722 * texel.b,
    )
    expect(percentile(luminance, 0.9) - percentile(luminance, 0.1)).toBeGreaterThan(0.1)
  })

  it('keeps card occlusion a contact term rather than a second exposure', () => {
    const ao = opaqueTexels().map((texel) => texel.ao)
    expect(percentile(ao, 0.5)).toBeGreaterThan(0.65)
    expect(percentile(ao, 0.01)).toBeGreaterThan(0.35)
    // It still has to be doing something, or overlapping blades never separate.
    expect(percentile(ao, 0.9) - percentile(ao, 0.1)).toBeGreaterThan(0.06)
  })

  it('varies blade translucency instead of pinning it to one ceiling', () => {
    // A uniform thickness makes a backlit crown light up as a single flat sheet
    // of lime, because the shader has nothing left to modulate.
    const translucency = opaqueTexels().map((texel) => texel.trans)
    expect(percentile(translucency, 0.9) - percentile(translucency, 0.1))
      .toBeGreaterThan(0.25)
  })
})

/** Box-filters an RGBA cutout the way the GPU does. */
function downsample(level: { data: Uint8Array; size: number }) {
  const half = level.size >> 1
  const next = new Uint8Array(half * half * 4)
  for (let y = 0; y < half; y += 1) {
    for (let x = 0; x < half; x += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        let total = 0
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            total += level.data[((y * 2 + dy) * level.size + x * 2 + dx) * 4 + channel]!
          }
        }
        next[(y * half + x) * 4 + channel] = Math.round(total / 4)
      }
    }
  }
  return { data: next, size: half }
}

/** Alpha-weighted mean colour: what the surface actually looks like. */
function weightedMean(data: Uint8Array, size: number): number[] {
  const totals = [0, 0, 0]
  let weight = 0
  for (let index = 0; index < size * size; index += 1) {
    const alpha = data[index * 4 + 3]! / 255
    if (alpha <= 0.01) continue
    for (const channel of [0, 1, 2]) {
      totals[channel]! += data[index * 4 + channel]! * alpha
    }
    weight += alpha
  }
  return totals.map((total) => total / Math.max(1, weight))
}
