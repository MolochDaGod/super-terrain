/**
 * Analytic fractured-granite field ported from scifi-kit's
 * `glacial-granite-boulder/field.ts`.
 *
 * This stays structurally identical to the source recipe: formation is chosen
 * by seed, all authored joint planes/spalls are retained, and no editor-side
 * shape attenuation is inserted into the field.
 */

import { graniteMassingOfSeed, type GraniteMassing } from './types'
import {
  boxoid,
  fbm,
  hash01,
  normalize,
  ridged,
  smax,
  smin,
  worleyBorder,
  type GraniteVec3,
} from './glacialGraniteNoise'

interface MassParameters {
  formation: GraniteMassing
  radii: GraniteVec3
  facets: Float64Array
  facetCount: number
  scars: Float64Array
  scarCount: number
  lobes: Float64Array
  lobeCount: number
}

interface Band {
  wavelength: number
  amplitude: number
  evaluate(x: number, y: number, z: number, seed: number): number
}

const massParameterCache = new Map<number, MassParameters>()

function buildMassParameters(seed: number): MassParameters {
  const formation = graniteMassingOfSeed(seed)
  const pick = (index: number) => hash01(seed, index, 77, 0x2545f491)
  const envelopes: Record<GraniteMassing, GraniteVec3> = {
    erratic: [0.88, 0.74, 0.79],
    prow: [0.72, 0.88, 0.6],
    arch: [0.92, 0.78, 0.48],
    tor: [0.86, 0.7, 0.76],
    bench: [0.98, 0.52, 0.76],
    monolith: [0.56, 0.96, 0.54],
  }
  const envelope = envelopes[formation]
  const radii: GraniteVec3 = [
    envelope[0] + (pick(1) - 0.5) * 0.08,
    envelope[1] + (pick(2) - 0.5) * 0.07,
    envelope[2] + (pick(3) - 0.5) * 0.08,
  ]

  const facets: number[] = []
  const addFacet = (normal: GraniteVec3, support: number, blend: number) => {
    const unit = normalize(normal)
    const extent = Math.sqrt(
      (unit[0] * radii[0]) ** 2 +
      (unit[1] * radii[1]) ** 2 +
      (unit[2] * radii[2]) ** 2,
    )
    facets.push(unit[0], unit[1], unit[2], extent * support, blend)
  }

  const jointSets: GraniteVec3[] = [
    normalize([0.96, 0.12, -0.25]),
    normalize([-0.19, 0.07, 0.98]),
    normalize([0.44, 0.34, 0.83]),
  ]
  for (let set = 0; set < jointSets.length; set += 1) {
    const axis = jointSets[set]!
    for (const sign of [1, -1]) {
      for (let step = 0; step < 2; step += 1) {
        const wobble = (index: number) =>
          (pick(set * 20 + step * 5 + index) - 0.5) * 0.16
        addFacet(
          [
            axis[0] * sign + wobble(1),
            axis[1] * sign + wobble(2),
            axis[2] * sign + wobble(3),
          ],
          0.62 + pick(set * 30 + step * 3 + (sign > 0 ? 0 : 1)) * 0.26,
          0.002 + pick(set * 40 + step) * 0.006,
        )
      }
    }
  }

  const breakCount = formation === 'arch' ? 14 : formation === 'tor' ? 20 : 30
  for (let index = 0; index < breakCount; index += 1) {
    const theta = (index / breakCount) * Math.PI * 2 + pick(100 + index) * 0.9
    const rise = -0.3 + pick(120 + index) * 1.25
    addFacet(
      [Math.cos(theta), rise, Math.sin(theta)],
      0.55 + pick(140 + index) * 0.29,
      0.0012 + pick(160 + index) * 0.0035,
    )
  }
  addFacet([0.03, -0.99, -0.05], 0.6, 0.004)

  // Surface spalls must stay subordinate to the joint planes. The former
  // 0.2–0.42 source-unit bites became ten-to-twenty-metre circular craters when
  // a valid granite asset was reused as a terrain-scale CSG patch. More,
  // smaller anisotropic boxoid spalls preserve chipped parallax without
  // changing the mass into a pock-marked asteroid.
  const scarCount = formation === 'arch' ? 4 : formation === 'monolith' ? 6 : 8
  const scars = new Float64Array(scarCount * 9)
  for (let index = 0; index < scarCount; index += 1) {
    const theta = 0.7 + index * 1.29 + pick(200 + index) * 0.7
    const radius = 0.032 + pick(220 + index) * 0.044
    const distance = 0.98 + radius * (0.42 + pick(240 + index) * 0.26)
    const yaw = pick(320 + index) * Math.PI
    const offset = index * 9
    scars[offset] = Math.cos(theta) * distance
    scars[offset + 1] = -0.2 + pick(260 + index) * 0.78
    scars[offset + 2] = Math.sin(theta) * distance
    scars[offset + 3] = radius * (0.55 + pick(275 + index) * 0.7)
    scars[offset + 4] = radius * (0.28 + pick(280 + index) * 0.48)
    scars[offset + 5] = radius * (1.05 + pick(290 + index) * 1.15)
    scars[offset + 6] = 0.001 + pick(300 + index) * 0.0035
    scars[offset + 7] = Math.cos(yaw)
    scars[offset + 8] = Math.sin(yaw)
  }

  const lobeCount = formation === 'arch' ? 2 : formation === 'tor' ? 6 : 4
  const lobes = new Float64Array(lobeCount * 8)
  for (let index = 0; index < lobeCount; index += 1) {
    const theta = 1.9 + index * 1.65 + pick(340 + index) * 0.9
    const radius = 0.15 + pick(360 + index) * 0.13
    const yaw = pick(440 + index) * Math.PI
    const offset = index * 8
    lobes[offset] = Math.cos(theta) * (0.34 + pick(380 + index) * 0.22)
    lobes[offset + 1] = -0.22 + pick(400 + index) * 0.5
    lobes[offset + 2] = Math.sin(theta) * (0.32 + pick(420 + index) * 0.22)
    lobes[offset + 3] = radius
    lobes[offset + 4] = radius * (0.55 + pick(430 + index) * 0.7)
    lobes[offset + 5] = radius * (0.7 + pick(435 + index) * 0.6)
    lobes[offset + 6] = Math.cos(yaw)
    lobes[offset + 7] = Math.sin(yaw)
  }

  return {
    formation,
    radii,
    facets: new Float64Array(facets),
    facetCount: facets.length / 5,
    scars,
    scarCount,
    lobes,
    lobeCount,
  }
}

function massParameters(seed: number): MassParameters {
  let parameters = massParameterCache.get(seed)
  if (!parameters) {
    parameters = buildMassParameters(seed)
    massParameterCache.set(seed, parameters)
  }
  return parameters
}

function ellipsoid(
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
): number {
  const nx = x / rx
  const ny = y / ry
  const nz = z / rz
  return (Math.sqrt(nx * nx + ny * ny + nz * nz) - 1) * Math.min(rx, ry, rz)
}

function massSdf(
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  const parameters = massParameters(seed)
  const radii = parameters.radii
  const leanX = x + y * 0.07
  const leanZ = z - y * 0.09
  const taper = 1 - Math.max(-0.1, Math.min(0.24, y * 0.26))
  let distance: number
  switch (parameters.formation) {
    case 'arch':
      distance = boxoid(leanX, y, leanZ, radii[0] * taper, radii[1], radii[2])
      break
    case 'tor': {
      const base = boxoid(leanX + 0.12, y + 0.24, leanZ, radii[0] * 0.9, radii[1] * 0.7, radii[2])
      const crown = boxoid(leanX - 0.18, y - 0.34, leanZ + 0.08, radii[0] * 0.68, radii[1] * 0.48, radii[2] * 0.82)
      const shoulder = boxoid(leanX + 0.38, y - 0.05, leanZ - 0.12, radii[0] * 0.42, radii[1] * 0.5, radii[2] * 0.64)
      distance = smin(smin(base, crown, 0.045), shoulder, 0.035)
      break
    }
    case 'bench': {
      const body = boxoid(leanX - 0.12, y + 0.18, leanZ, radii[0] * 0.82, radii[1] * 0.78, radii[2])
      const shelf = boxoid(leanX + 0.16, y - 0.27, leanZ - 0.05, radii[0], radii[1] * 0.34, radii[2] * 0.82)
      distance = smin(body, shelf, 0.035)
      break
    }
    case 'prow': {
      const body = boxoid(leanX, y, leanZ, radii[0] * taper, radii[1], radii[2] * taper)
      const shoulder = boxoid(leanX - 0.28, y - 0.18, leanZ + 0.08, radii[0] * 0.55, radii[1] * 0.48, radii[2] * 0.78)
      distance = smin(body, shoulder, 0.04)
      break
    }
    default:
      distance = boxoid(leanX, y, leanZ, radii[0] * taper, radii[1], radii[2] * taper)
  }

  for (let index = 0; index < parameters.facetCount; index += 1) {
    const offset = index * 5
    const plane = x * parameters.facets[offset]! +
      y * parameters.facets[offset + 1]! +
      z * parameters.facets[offset + 2]! -
      parameters.facets[offset + 3]!
    distance = smax(distance, plane, parameters.facets[offset + 4]!)
  }

  for (let index = 0; index < parameters.lobeCount; index += 1) {
    const offset = index * 8
    const lx = x - parameters.lobes[offset]!
    const lz = z - parameters.lobes[offset + 2]!
    const cosine = parameters.lobes[offset + 6]!
    const sine = parameters.lobes[offset + 7]!
    distance = smin(
      distance,
      boxoid(
        lx * cosine - lz * sine,
        y - parameters.lobes[offset + 1]!,
        lx * sine + lz * cosine,
        parameters.lobes[offset + 3]!,
        parameters.lobes[offset + 4]!,
        parameters.lobes[offset + 5]!,
      ),
      0.05,
    )
  }

  for (let index = 0; index < parameters.scarCount; index += 1) {
    const offset = index * 9
    const sx = x - parameters.scars[offset]!
    const sz = z - parameters.scars[offset + 2]!
    const cosine = parameters.scars[offset + 7]!
    const sine = parameters.scars[offset + 8]!
    distance = smax(
      distance,
      -boxoid(
        sx * cosine - sz * sine,
        y - parameters.scars[offset + 1]!,
        sx * sine + sz * cosine,
        parameters.scars[offset + 3]!,
        parameters.scars[offset + 4]!,
        parameters.scars[offset + 5]!,
      ),
      parameters.scars[offset + 6]!,
    )
  }

  if (parameters.formation === 'arch') {
    const openingX = (hash01(seed, 901, 77, 0x2545f491) - 0.5) * 0.12
    const shaft = boxoid(x - openingX, y + 0.62, z, 0.36, 0.43, 0.72)
    const crown = ellipsoid(x - openingX, y + 0.14, z, 0.43, 0.43, 0.72)
    distance = smax(distance, -smin(shaft, crown, 0.025), 0.008)
  }
  return distance
}

const BANDS: Band[] = [
  {
    wavelength: 0.72,
    amplitude: 0.052,
    evaluate: (x, y, z, seed) => {
      const wx = x + fbm(x * 1.05 + 3.1, y * 1.05, z * 1.05, seed + 11, 3) * 0.4
      const wy = y + fbm(x, y - 5.7, z, seed + 43, 3) * 0.3
      const wz = z + fbm(x * 1.1, y * 1.1, z * 1.1 + 8.4, seed + 79, 3) * 0.4
      const spine = ridged(wx * 1.75, wy * 1.35, wz * 1.75, seed + 137, 3)
      const broad = fbm(wx * 1.5, wy * 1.25, wz * 1.5, seed + 101, 3) * 2
      return broad * 0.42 + (spine - 0.4) * 1.15
    },
  },
  {
    wavelength: 0.23,
    amplitude: 0.017,
    evaluate: (x, y, z, seed) => {
      const warp = fbm(x * 2.9 + 6.7, y * 2.9, z * 2.9, seed + 307, 3) * 0.26
      const cells = worleyBorder((x + warp) * 5.4, y * 4.3, (z - warp) * 5.4, seed + 389)
      const plate = 1 - Math.min(1, cells / 0.44)
      const spine = ridged((x + warp) * 4.6, y * 3.9, (z + warp) * 4.6, seed + 421, 2)
      const broken = fbm((x + warp) * 5.6, (y - warp * 0.45) * 4.4, (z + warp) * 5.6, seed + 347, 3) * 2
      return broken * 0.34 + (spine - 0.42) * 0.7 - plate * plate * 0.62
    },
  },
  {
    wavelength: 0.085,
    amplitude: 0.0055,
    evaluate: (x, y, z, seed) => {
      const warp = fbm(x * 7 + 1.3, y * 7, z * 7, seed + 503, 2) * 0.14
      const chips = worleyBorder((x + warp) * 14.5, y * 11.5, (z - warp) * 14.5, seed + 541)
      const scar = 1 - Math.min(1, chips / 0.42)
      const bedding = ridged(x * 6.5, y * 21.5, z * 6.5, seed + 577, 2)
      const grit = fbm(x * 13.5, y * 13.5, z * 13.5, seed + 613, 3) * 2
      return grit * 0.36 - scar * scar * 0.62 - (bedding - 0.4) * 0.5
    },
  },
]

export function graniteOctaveBudget(cells: number): {
  minimumWavelength: number
} {
  return { minimumWavelength: (2 / cells) * 3 }
}

function displacement(
  x: number,
  y: number,
  z: number,
  seed: number,
  minimumWavelength: number,
): number {
  let total = 0
  for (const band of BANDS) {
    if (band.wavelength < minimumWavelength) continue
    total += band.evaluate(x, y, z, seed) * band.amplitude
  }
  return total
}

export function createGlacialGraniteField(seed: number) {
  return {
    sdf(
      x: number,
      y: number,
      z: number,
      _seed: number,
      minimumWavelength: number,
    ): number {
      return massSdf(x, y, z, seed) -
        displacement(x, y, z, seed, minimumWavelength)
    },
    octaveBudget: graniteOctaveBudget,
  }
}
