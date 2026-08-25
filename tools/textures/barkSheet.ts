import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodePng } from '../capture/png'
import { bakeBarkMaps } from '../../src/tree/materials/bark/bake'
import { TREE_SPECIES_DEFINITIONS } from '../../src/tree/generator/speciesCatalog'
import type { TreeSpecies } from '../../src/tree/generator/types'

/**
 * Offline bark preview. Bakes each species' bark tile and writes both the raw
 * albedo and a simple lit render, so relief and colour can be judged without
 * booting the editor.
 */
const outDir = resolve(process.cwd(), '.textures/bark')
mkdirSync(outDir, { recursive: true })
const W = Number(process.env.BARK_W ?? 512)
const H = W * 2

const only = process.env.BARK_ONLY?.split(',').filter(Boolean)
const species = (only ?? TREE_SPECIES_DEFINITIONS.map((s) => s.id)) as TreeSpecies[]

function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
function toSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** Simple sun + sky lit render of the baked maps, matching material.ts roughly. */
function render(maps: ReturnType<typeof bakeBarkMaps>): Uint8Array {
  const { width, height, albedo, normal, roughness, normalScale } = maps
  const out = new Uint8Array(width * height * 4)
  // Sun from upper left, slightly toward the viewer.
  const L = [-0.55, 0.62, 0.56]
  const len = Math.hypot(L[0]!, L[1]!, L[2]!)
  const l = L.map((c) => c / len)
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4
    let nx = (normal[o]! / 255 - 0.5) * 2 * normalScale * 8
    let ny = (normal[o + 1]! / 255 - 0.5) * 2 * normalScale * 8
    const nz = 1
    const inv = 1 / Math.hypot(nx, ny, nz)
    nx *= inv; ny *= inv
    const nzn = nz * inv
    const ndl = Math.max(0, nx * l[0]! + ny * l[1]! + nzn * l[2]!)
    const ao = roughness[o]! / 255
    const sky = 0.32 * (0.5 + 0.5 * nzn) * ao
    const light = ndl * 1.15 + sky
    for (let c = 0; c < 3; c += 1) {
      const a = toLinear(albedo[o + c]! / 255)
      out[o + c] = Math.round(Math.min(1, Math.max(0, toSrgb(a * light))) * 255)
    }
    out[o + 3] = 255
  }
  return out
}

for (const id of species) {
  const maps = bakeBarkMaps(1337, id, W, H)
  writeFileSync(resolve(outDir, `${id}-albedo.png`), encodePng(maps.albedo, W, H))
  writeFileSync(resolve(outDir, `${id}-lit.png`), encodePng(render(maps), W, H))
  // Report the statistics that separate a photograph from a painted cylinder.
  let min = 1, max = 0, sum = 0, sum2 = 0
  let satSum = 0
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4
    const r = maps.albedo[o]! / 255, g = maps.albedo[o + 1]! / 255, b = maps.albedo[o + 2]! / 255
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    min = Math.min(min, y); max = Math.max(max, y); sum += y; sum2 += y * y
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    satSum += mx > 0 ? (mx - mn) / mx : 0
  }
  const n = W * H
  const mean = sum / n
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean))
  console.log(
    `${id.padEnd(24)} mean ${mean.toFixed(3)} sd ${sd.toFixed(3)} ` +
    `range ${min.toFixed(3)}..${max.toFixed(3)} sat ${(satSum / n).toFixed(3)}`,
  )
}
console.log(`wrote ${species.length} previews to ${outDir}`)
