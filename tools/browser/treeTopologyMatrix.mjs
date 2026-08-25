// Deterministic visual-review matrix for every non-oak topology.
//
// This deliberately drives treeshot instead of importing the generator. The
// gate must see the same Chrome/WebGPU renderer, materials, lighting and LOD
// selection as the editor. Run one species while iterating:
//
//   node tools/browser/treeTopologyMatrix.mjs --species=baobab
//
// Or produce the complete review set after a topology-family pass:
//
//   node tools/browser/treeTopologyMatrix.mjs --all
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=')
    return [key, value]
  }),
)

// The canonical seeds are the authored presets. Two shared stress seeds expose
// symmetry, termination and self-intersection bugs that a single hero seed can
// conveniently hide.
const CANONICAL_SEEDS = new Map([
  ['windswept-pine', 71023],
  ['kapok-ceiba', 48127],
  ['baobab', 90217],
  ['coconut-palm', 66739],
  ['dragon-blood', 73331],
  ['norway-spruce', 11837],
  ['coast-redwood', 55271],
  ['monkey-puzzle', 34819],
  ['date-palm', 62039],
  ['tree-fern', 27449],
  ['quiver-tree', 80687],
  ['doum-palm', 46273],
  ['joshua-tree', 59113],
  ['bristlecone-pine', 93557],
  ['screw-pine-pandanus', 15991],
  ['banyan', 73133],
  ['mangrove', 42901],
  ['strangler-fig', 88741],
  ['umbrella-acacia', 24781],
  ['rainbow-eucalyptus', 61813],
  ['gum-eucalyptus', 37511],
  ['giant-sequoia', 96317],
  ['norfolk-island-pine', 51437],
  ['european-beech', 33049],
  ['silver-birch', 77419],
  ['cedar-of-lebanon', 68227],
  ['japanese-black-pine', 14593],
])
const STRESS_SEEDS = [73129, 275191]

const selected = flags.has('all')
  ? [...CANONICAL_SEEDS.keys()]
  : (flags.get('species') ?? '').split(',').filter(Boolean)

if (selected.length === 0) {
  console.error('Pass --species=<id[,id...]> or --all')
  process.exit(2)
}

const unknown = selected.filter((species) => !CANONICAL_SEEDS.has(species))
if (unknown.length > 0) {
  console.error(`Unknown or oak species: ${unknown.join(', ')}`)
  process.exit(2)
}

const url = flags.get('url') ?? 'http://127.0.0.1:5173'
const out = resolve(flags.get('out') ?? 'captures/tree-topology')
const shots = flags.get('shots') ?? 'hero,silhouette,roots,canopy,overhead'
const lods = flags.get('lods') ?? '0,1,2'
const canonicalOnly = flags.has('canonical-only')
const script = resolve(dirname(fileURLToPath(import.meta.url)), 'treeshot.mjs')

for (const species of selected) {
  const seeds = canonicalOnly
    ? [CANONICAL_SEEDS.get(species)]
    : [CANONICAL_SEEDS.get(species), ...STRESS_SEEDS]
  console.log(`\n=== ${species} · seeds ${seeds.join(', ')} · LOD ${lods} ===`)
  const result = spawnSync(process.execPath, [
    script,
    `--name=${species}`,
    `--url=${url}`,
    `--params=species:${species}`,
    `--seeds=${seeds.join(',')}`,
    `--shots=${shots}`,
    `--lods=${lods}`,
    `--out=${resolve(out, species)}`,
  ], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error(`${species} capture failed with status ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

console.log(`\nTopology review matrix written under ${out}`)
