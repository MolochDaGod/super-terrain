import { performance } from 'node:perf_hooks'
import { TREE_SPECIES_DEFINITIONS, type TreeSpecies } from '../src/tree/generator/speciesCatalog'
import { bakeBarkMaps } from '../src/tree/materials/bark/bake'
import { bakeLeafSpray } from '../src/tree/materials/leafSprayAtlas'
import { buildCutoutMipmaps } from '../src/tree/materials/leaf/mipmaps'

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=')
    return [key, value]
  }),
)

const species = (flags.get('species') ?? 'ancient-oak') as TreeSpecies
if (!TREE_SPECIES_DEFINITIONS.some((definition) => definition.id === species)) {
  throw new Error(`Unknown tree species: ${species}`)
}

const seed = Number(flags.get('seed') ?? 84721)
const barkWidth = Number(flags.get('bark-width') ?? 2048)
const barkHeight = Number(flags.get('bark-height') ?? barkWidth * 2)
const leafSize = Number(flags.get('leaf-size') ?? 512)
const variants = Number(flags.get('variants') ?? 8)

const timed = <T>(label: string, run: () => T): { value: T; ms: number } => {
  const started = performance.now()
  const value = run()
  return { value, ms: performance.now() - started }
}

const bark = timed('bark', () => bakeBarkMaps(seed, species, barkWidth, barkHeight))
const leafTimes: number[] = []
const mipTimes: number[] = []
let leafBytes = 0
let mipBytes = 0

for (let variant = 0; variant < variants; variant += 1) {
  const leaf = timed('leaf', () =>
    bakeLeafSpray(seed ^ 0x5f3759df, species, variant, leafSize))
  leafTimes.push(leaf.ms)
  leafBytes += leaf.value.albedo.byteLength + leaf.value.normal.byteLength +
    leaf.value.roughness.byteLength

  const mip = timed('mips', () => [
    buildCutoutMipmaps(leaf.value.albedo, leafSize, 'srgb-cutout', 0.3),
    buildCutoutMipmaps(leaf.value.normal, leafSize, 'normal-cutout', 0.3),
    buildCutoutMipmaps(leaf.value.roughness, leafSize, 'linear-cutout', 0.3),
  ])
  mipTimes.push(mip.ms)
  mipBytes += mip.value.reduce(
    (total, chain) => total + chain.reduce((sum, level) => sum + level.data.byteLength, 0),
    0,
  )
}

const totalMs = bark.ms + sum(leafTimes) + sum(mipTimes)
console.log(JSON.stringify({
  species,
  seed,
  bark: {
    size: `${barkWidth}x${barkHeight}`,
    ms: round(bark.ms),
    bytes: bark.value.albedo.byteLength + bark.value.normal.byteLength +
      bark.value.roughness.byteLength,
  },
  leaves: {
    size: `${leafSize}x${leafSize}`,
    variants,
    totalMs: round(sum(leafTimes)),
    perVariantMs: leafTimes.map(round),
    bytes: leafBytes,
  },
  mips: {
    totalMs: round(sum(mipTimes)),
    perVariantMs: mipTimes.map(round),
    bytes: mipBytes,
  },
  totalMs: round(totalMs),
  memoryMiB: round((bark.value.albedo.byteLength + bark.value.normal.byteLength +
    bark.value.roughness.byteLength + leafBytes + mipBytes) / 1_048_576),
}, null, 2))

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
