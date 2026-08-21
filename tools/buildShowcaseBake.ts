import { gzipSync } from 'node:zlib'
import { writeFile } from 'node:fs/promises'
import { DEFAULT_TERRAIN_CONFIG } from '../src/terrain/config'
import { compileTerrainSection } from '../src/terrain/compiler/compileSection'
import { expandBounds, intersects, sectionBounds } from '../src/terrain/core/bounds'
import type { CompiledSection } from '../src/terrain/core/types'
import { createShowcaseTerrainModifiers } from '../src/terrain/demo/createShowcaseModifiers'
import { encodeSectionBake } from '../src/terrain/prebake/sectionBake'
import { encodeModifiers } from '../src/terrain/workers/protocol'

const warn = console.warn
console.warn = (...values: unknown[]) => {
  if (values.some((value) => String(value).includes('maxLeafSize'))) return
  warn(...values)
}

const config = DEFAULT_TERRAIN_CONFIG
const modifiers = createShowcaseTerrainModifiers(config.seed)
  .sort((left, right) =>
    left.priority - right.priority || left.id.localeCompare(right.id),
  )
// Six cells contain the overlapping hero mass and account for most of the
// cold CSG tail. Baking the other 24 modified cells would add ~27 MiB of
// compressed data to save only inexpensive, fully parallel worker jobs.
const keys = [
  { x: 1, z: 0 },
  { x: 2, z: 0 },
  { x: 3, z: 0 },
  { x: 1, z: 1 },
  { x: 2, z: 1 },
  { x: 3, z: 1 },
] as const

const compiled: CompiledSection[] = []
for (const key of keys) {
  const query = expandBounds(
    sectionBounds(key, config.sectionSize),
    config.operationHalo,
  )
  const relevant = modifiers.filter((modifier) =>
    modifier.enabled && intersects(modifier.bounds, query),
  )
  const section = compileTerrainSection({
    kind: 'compile-section',
    jobId: compiled.length + 1,
    key,
    revision: 0,
    priority: 0,
    config: {
      sectionSize: config.sectionSize,
      lodResolutions: config.lodResolutions,
      seed: config.seed,
      operationHalo: config.operationHalo,
    },
    // The showcase camera never needs LOD0 in these cells. If an editor camera
    // later approaches one closely, the normal worker refinement path still
    // replaces this immutable startup result with a fresh LOD0 compile.
    // One LOD1 stream is enough for the cinematic framing. Keeping the exact
    // operand triangles means this is almost visually identical to the four-
    // LOD result, while avoiding three duplicate attribute payloads. Runtime
    // still requests and installs LOD0 when the editor camera moves in close.
    levels: [1],
    modifiers: encodeModifiers(relevant),
  })
  compiled.push(section)
  console.log(
    `${key.x}:${key.z} · ${Math.round(section.metadata.compileMs)}ms · ` +
    `${section.metadata.triangleCount} source triangles`,
  )
}

const encoded = encodeSectionBake(compiled)
const compressed = gzipSync(encoded, { level: 9 })
const destination = new URL(
  '../src/terrain/react/assets/showcase-sections-v22.bin.gz',
  import.meta.url,
)
await writeFile(destination, compressed)
console.log(
  `${compiled.length} sections · ${(encoded.byteLength / 1_048_576).toFixed(1)} MiB raw · ` +
  `${(compressed.byteLength / 1_048_576).toFixed(1)} MiB gzip`,
)
