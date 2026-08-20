import { createOutcropFieldModifiers } from '../src/terrain/demo/createOutcropField'
import { DEFAULT_TERRAIN_CONFIG } from '../src/terrain/config'
const t0 = performance.now()
const mods = createOutcropFieldModifiers(DEFAULT_TERRAIN_CONFIG.seed)
let tris = 0, volumes = 0
for (const m of mods as any[]) for (const v of m.volumes) { volumes++; tris += v.indices.length / 3 }
console.log('build ms', (performance.now()-t0).toFixed(0), 'modifiers', mods.length, 'volumes', volumes, 'tris', tris)
