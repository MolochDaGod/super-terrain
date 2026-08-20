import { createDemoTerrainModifiers } from '../src/terrain/demo/createDemoModifiers'
import { DEFAULT_TERRAIN_CONFIG } from '../src/terrain/config'
import { compileTerrainSection } from '../src/terrain/compiler/compileSection'
import { encodeModifiers } from '../src/terrain/workers/protocol'
const all = createDemoTerrainModifiers(DEFAULT_TERRAIN_CONFIG.seed)
const encoded = encodeModifiers(all)
let total = 0
for (let x = 2; x <= 4; x++) for (let z = -1; z <= 2; z++) {
  const t = performance.now()
  compileTerrainSection({ kind:'compile-section', jobId:1, key:{x,z}, revision:1, priority:1,
    config: { ...DEFAULT_TERRAIN_CONFIG, lodResolutions:[96,48,24,12,6] }, modifiers: encoded })
  const ms = performance.now()-t; total += ms
  if (ms > 2000) console.log(' slow', x, z, ms.toFixed(0))
}
console.log('total ms', total.toFixed(0))
