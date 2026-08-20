import { describe, expect, it } from 'vitest'
import { duneField, duneProfile, sampleHeightField } from './heightField'
import {
  evaluateTerrainLayerWeights,
  evaluateTerrainMaterialFields,
} from './TerrainMaterialFields'

const SEED = 13_371
const HALF_WORLD = 8_192

interface Probe {
  x: number
  z: number
  y: number
  aridity: number
}

/** Coarse survey of the whole world, reused by every case below. */
const probes: Probe[] = (() => {
  const found: Probe[] = []
  for (let x = -HALF_WORLD; x < HALF_WORLD; x += 512) {
    for (let z = -HALF_WORLD; z < HALF_WORLD; z += 512) {
      const sample = sampleHeightField(x, z, SEED)
      found.push({ x, z, y: sample.height, aridity: sample.aridity })
    }
  }
  return found
})()

/** Coverage on notionally flat, uncurved ground at a probe. */
function flatGroundWeights(probe: Probe) {
  const fields = evaluateTerrainMaterialFields(probe.x, probe.y, probe.z, SEED)
  return evaluateTerrainLayerWeights(probe.x, probe.y, probe.z, 0.97, 0, fields)
}

describe('aridity as a biome selector', () => {
  it('covers the world with both climates and a wide margin between them', () => {
    const arid = probes.filter((probe) => probe.aridity > 0.7).length
    const temperate = probes.filter((probe) => probe.aridity < 0.2).length
    const margin = probes.filter(
      (probe) => probe.aridity >= 0.2 && probe.aridity <= 0.8,
    ).length

    // A world that is all one climate has no biome diversity, and one that is
    // half each with a hard edge has no margin to blend across. Both failure
    // modes are what these bounds exist to catch.
    expect(arid / probes.length).toBeGreaterThan(0.05)
    expect(arid / probes.length).toBeLessThan(0.35)
    expect(temperate / probes.length).toBeGreaterThan(0.3)
    expect(margin / probes.length).toBeGreaterThan(0.15)
  })

  it('varies over kilometres, never within a section', () => {
    // The selector is interpolated across each section from its vertices, so a
    // step inside one section would appear as a visible seam in the material.
    let largest = 0
    for (const probe of probes) {
      const neighbour = sampleHeightField(probe.x + 128, probe.z, SEED).aridity
      largest = Math.max(largest, Math.abs(neighbour - probe.aridity))
    }
    expect(largest).toBeLessThan(0.15)
  })
})

describe('arid coverage', () => {
  const low = probes.filter((probe) => probe.y < 140)
  const driest = [...low].sort((a, b) => b.aridity - a.aridity).slice(0, 12)
  const wettest = [...low].sort((a, b) => a.aridity - b.aridity).slice(0, 12)

  it('strips vegetation from desert ground', () => {
    for (const probe of driest) {
      const weights = flatGroundWeights(probe)
      expect(probe.aridity).toBeGreaterThan(0.8)
      // Scrub and wash survive as a trace along drainage; a sward does not.
      expect(weights.grass + weights.meadow).toBeLessThan(0.2)
    }
  })

  it('leaves desert ground as sand and pavement rather than bare rock', () => {
    // Aridity must not simply delete the regolith: a desert basin is floored
    // with mobile sand and armoured lag, and reading it as scoured bedrock is
    // the most common way a procedural desert goes wrong.
    for (const probe of driest) {
      const weights = flatGroundWeights(probe)
      expect(weights.soil + weights.scree).toBeGreaterThan(0.6)
    }
  })

  it('keeps temperate ground vegetated', () => {
    for (const probe of wettest) {
      const weights = flatGroundWeights(probe)
      expect(probe.aridity).toBeLessThan(0.05)
      expect(weights.grass + weights.meadow).toBeGreaterThan(0.35)
    }
  })

  it('never lets coverage exceed unity in either climate', () => {
    for (const probe of [...driest, ...wettest]) {
      const weights = flatGroundWeights(probe)
      const total =
        weights.grass +
        weights.meadow +
        weights.soil +
        weights.scree +
        weights.rock +
        weights.snow
      expect(total).toBeGreaterThan(0.9)
      expect(total).toBeLessThan(1.05)
    }
  })
})

describe('the dune profile', () => {
  it('is asymmetric: a long windward ramp and a short slipface', () => {
    // This asymmetry is the entire reason a dune reads as a dune rather than as
    // a hill. Any symmetric noise function produces the hill.
    let rising = 0
    let falling = 0
    for (let step = 0; step < 2000; step += 1) {
      const here = duneProfile(step / 2000)
      const next = duneProfile((step + 1) / 2000)
      if (next > here) rising += 1
      else falling += 1
    }
    expect(rising / 2000).toBeGreaterThan(0.68)
    expect(rising / 2000).toBeLessThan(0.78)
  })

  it('puts the slipface at the angle of repose relative to the ramp', () => {
    let steepestRise = 0
    let steepestFall = 0
    for (let step = 0; step < 2000; step += 1) {
      const gradient =
        (duneProfile((step + 1) / 2000) - duneProfile(step / 2000)) * 2000
      steepestRise = Math.max(steepestRise, gradient)
      steepestFall = Math.max(steepestFall, -gradient)
    }
    // Sand cannot hold a windward slope anywhere near the angle it slips at.
    expect(steepestFall / steepestRise).toBeGreaterThan(1.8)
  })

  it('is continuous across the phase wrap and the brink', () => {
    // The wrap is where one dune's slipface toe meets the next dune's ramp, and
    // a discontinuity there prints a wall along the base of every slipface in
    // the field. Because it is periodic it reads as deliberate architecture
    // rather than as a glitch, which is what makes it easy to miss.
    for (const edge of [0, 0.73, 1]) {
      const before = duneProfile(edge - 0.0005)
      const after = duneProfile(edge + 0.0005)
      expect(Math.abs(after - before)).toBeLessThan(0.02)
    }
  })
})

describe('the dune field', () => {
  const ergCentre = { x: -6_272, z: 2_176 }

  it('never steps, at any sampling distance the mesher might use', () => {
    // Sampled finer than the finest LOD, so a step shows up as a step rather
    // than as a plausibly steep slope.
    let largest = 0
    for (let step = 0; step < 4_000; step += 1) {
      const x = ergCentre.x + (step % 64) * 6
      const z = ergCentre.z + Math.floor(step / 64) * 6
      const here = duneField(x, z, SEED)
      for (const [dx, dz] of [
        [0.25, 0],
        [0, 0.25],
      ]) {
        largest = Math.max(largest, Math.abs(duneField(x + dx, z + dz, SEED) - here))
      }
    }
    // A slipface at the angle of repose covers 0.17 m over a 0.25 m step.
    expect(largest).toBeLessThan(0.22)
  })

  it('keeps every slope within what dry sand can hold', () => {
    let overRepose = 0
    let samples = 0
    for (let step = 0; step < 4_000; step += 1) {
      const x = ergCentre.x + (step % 64) * 6
      const z = ergCentre.z + Math.floor(step / 64) * 6
      const here = duneField(x, z, SEED)
      const gradient = Math.hypot(
        duneField(x + 1.35, z, SEED) - here,
        duneField(x, z + 1.35, SEED) - here,
      ) / 1.35
      samples += 1
      if ((Math.atan(gradient) * 180) / Math.PI > 36) overRepose += 1
    }
    // Local oversteepening at a brink is real; a field of it is not.
    expect(overRepose / samples).toBeLessThan(0.03)
  })
})

describe('erg coverage', () => {
  const ergProbes = probes.filter((probe) => probe.aridity > 0.9)

  it('places sand seas only in dry, low basins, and not over the whole desert', () => {
    const inErg = probes.filter(
      (probe) => sampleHeightField(probe.x, probe.z, SEED).erg > 0.5,
    )
    // Most of a desert is bedrock, pavement and wadi, not dunes. A world where
    // every arid cell is an erg has traded one uniform biome for another.
    expect(inErg.length / probes.length).toBeGreaterThan(0.01)
    expect(inErg.length / probes.length).toBeLessThan(0.15)
    expect(ergProbes.length).toBeGreaterThan(0)
    for (const probe of inErg) {
      expect(sampleHeightField(probe.x, probe.z, SEED).aridity).toBeGreaterThan(0.7)
    }
  })

  it('reads a slipface as clean sand rather than as armoured pavement', () => {
    // The coverage classifier decides from slope, and a slipface is steep. Left
    // to itself it hands back the same lag gravel it would give a talus cone,
    // which is the exact opposite of what a slipface is made of.
    const steep = []
    for (let step = 0; step < 3_000; step += 1) {
      const x = -6_272 + (step % 55) * 8
      const z = 2_176 + Math.floor(step / 55) * 8
      const sample = sampleHeightField(x, z, SEED)
      if (sample.erg < 0.8) continue
      const gradient = Math.hypot(
        sampleHeightField(x + 1.35, z, SEED).height - sample.height,
        sampleHeightField(x, z + 1.35, SEED).height - sample.height,
      ) / 1.35
      if (gradient > 0.5) steep.push({ x, z, y: sample.height, gradient })
    }
    expect(steep.length).toBeGreaterThan(10)

    for (const face of steep.slice(0, 25)) {
      const fields = evaluateTerrainMaterialFields(face.x, face.y, face.z, SEED)
      const normalY = 1 / Math.hypot(1, face.gradient)
      const weights = evaluateTerrainLayerWeights(
        face.x,
        face.y,
        face.z,
        normalY,
        0,
        fields,
      )
      expect(weights.soil).toBeGreaterThan(0.85)
      expect(weights.scree).toBeLessThan(0.1)
    }
  })
})
