import { DEFAULT_TERRAIN_CONFIG } from '../src/terrain/config'
import { compileTerrainSection } from '../src/terrain/compiler/compileSection'
import { expandBounds, intersects, sectionBounds } from '../src/terrain/core/bounds'
import { createShowcaseTerrainModifiers } from '../src/terrain/demo/createShowcaseModifiers'
import { encodeModifiers } from '../src/terrain/workers/protocol'

const warn = console.warn
console.warn = (...values: unknown[]) => {
  if (values.some((value) => String(value).includes('maxLeafSize'))) return
  warn(...values)
}

/**
 * Profiles only section/operand intersections in the shipped showcase.
 *
 * Usage: `bun tools/probeCompile3.ts [minimumLod]`. The browser normally asks
 * for one source LOD plus every coarser level, so the default mirrors the focal
 * hero/mountain requests rather than compiling the entire world at LOD0.
 */
const minimumLod = Math.max(
  0,
  Math.min(
    DEFAULT_TERRAIN_CONFIG.lodResolutions.length - 1,
    Number(Bun.argv[2] ?? 1),
  ),
)
const levels = Array.from(
  { length: DEFAULT_TERRAIN_CONFIG.lodResolutions.length - minimumLod },
  (_, offset) => minimumLod + offset,
)
const modifiers = createShowcaseTerrainModifiers(DEFAULT_TERRAIN_CONFIG.seed)
  .sort((left, right) =>
    left.priority - right.priority || left.id.localeCompare(right.id),
  )
const sectionSize = DEFAULT_TERRAIN_CONFIG.sectionSize
const halo = DEFAULT_TERRAIN_CONFIG.operationHalo
const keys = new Map<string, { x: number; z: number }>()

for (const modifier of modifiers) {
  const minX = Math.floor((modifier.bounds.min.x - halo) / sectionSize)
  const maxX = Math.floor((modifier.bounds.max.x + halo) / sectionSize)
  const minZ = Math.floor((modifier.bounds.min.z - halo) / sectionSize)
  const maxZ = Math.floor((modifier.bounds.max.z + halo) / sectionSize)
  for (let z = minZ; z <= maxZ; z += 1) {
    for (let x = minX; x <= maxX; x += 1) keys.set(`${x}:${z}`, { x, z })
  }
}

const results: Array<{
  section: string
  ms: number
  triangles: number
  operands: number
  ids: string
}> = []

for (const key of keys.values()) {
  const queryBounds = expandBounds(sectionBounds(key, sectionSize), halo)
  const relevant = modifiers.filter((modifier) =>
    modifier.enabled && intersects(modifier.bounds, queryBounds),
  )
  const compiled = compileTerrainSection({
    kind: 'compile-section',
    jobId: 1,
    key,
    revision: 1,
    priority: 1,
    config: {
      sectionSize,
      lodResolutions: DEFAULT_TERRAIN_CONFIG.lodResolutions,
      seed: DEFAULT_TERRAIN_CONFIG.seed,
      operationHalo: halo,
    },
    levels,
    modifiers: encodeModifiers(relevant),
  })
  results.push({
    section: `${key.x}:${key.z}`,
    ms: Math.round(compiled.metadata.compileMs),
    triangles: Math.round(compiled.metadata.triangleCount),
    operands: relevant.reduce(
      (count, modifier) => count + (
        modifier.type === 'boolean-volume' ? modifier.volumes.length : 1
      ),
      0,
    ),
    ids: relevant.map((modifier) => modifier.id).join(', '),
  })
}

results.sort((left, right) => right.ms - left.ms)
console.table(results)
console.log(
  `LOD ${minimumLod}+ · ${results.length} modified sections · ` +
  `${results.reduce((sum, result) => sum + result.ms, 0)} worker-ms total`,
)
