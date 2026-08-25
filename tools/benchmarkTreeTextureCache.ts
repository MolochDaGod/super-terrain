import { performance } from 'node:perf_hooks'
import type { TreeSpecies } from '../src/tree/generator/types'
import { bakeProceduralTreeTexturesAsync } from '../src/tree/materials/proceduralTreeTextureClient'

const species = (process.argv[2] ?? 'ancient-oak') as TreeSpecies
const seed = Number(process.argv[3] ?? 84721)

const startedCold = performance.now()
const first = await bakeProceduralTreeTexturesAsync(species, seed)
const coldMs = performance.now() - startedCold

const startedHot = performance.now()
const second = await bakeProceduralTreeTexturesAsync(species, seed + 1)
const hotMs = performance.now() - startedHot

console.log(JSON.stringify({
  species,
  coldTreeSeed: seed,
  hotTreeSeed: seed + 1,
  coldMs,
  hotMs,
}, null, 2))
second.dispose()
first.dispose()
