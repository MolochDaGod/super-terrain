/**
 * Pass-level breakdown of one bark bake.
 *
 * The bake is the single most expensive thing in a forest build, and the four
 * passes inside it have very different shapes: one is per-texel and trivially
 * parallel, one is a neighbourhood integral, two are cheap. Optimising it
 * without this breakdown is guesswork.
 */
import { performance } from 'node:perf_hooks'
import type { TreeSpecies } from '../src/tree/generator/types'
import { packBarkAlbedo, packBarkRoughness } from '../src/tree/materials/bark/albedo'
import { packBarkAmbientOcclusion } from '../src/tree/materials/bark/ambientOcclusion'
import { bakeBarkFields, barkRelief } from '../src/tree/materials/bark/fields'
import { barkProfileFor } from '../src/tree/materials/bark/profiles'

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=')
    return [key, value]
  }),
)
const species = (flags.get('species') ?? 'european-beech') as TreeSpecies
const width = Number(flags.get('width') ?? 1024)
const height = Number(flags.get('height') ?? 2048)
const seed = Number(flags.get('seed') ?? 84721)

const profile = barkProfileFor(species)
const pixels = width * height
const albedo = new Uint8Array(pixels * 4)
const normal = new Uint8Array(pixels * 4)
const roughness = new Uint8Array(pixels * 4)

const time = <T>(label: string, run: () => T): T => {
  const started = performance.now()
  const value = run()
  console.log(`${label}: ${Math.round(performance.now() - started)}ms`)
  return value
}

const total = performance.now()
const fields = time('fields', () => bakeBarkFields(seed, profile, width, height))
time('albedo', () => packBarkAlbedo(fields, profile.palette, profile, albedo, seed))
time('roughness', () => packBarkRoughness(fields, roughness))
time('occlusion', () =>
  packBarkAmbientOcclusion(fields.relief, fields.furrow, roughness, width, height, fields.lip))
time('relief', () => barkRelief(fields, normal, profile.normalStrength))
console.log(`total: ${Math.round(performance.now() - total)}ms · ${species} ${width}x${height}`)
