import { DEFAULT_TERRAIN_CONFIG } from '../../src/terrain/config'
import { sampleHeightField } from '../../src/terrain/compiler/heightField'

/**
 * Prints an elevation map of the world so camera presets can be aimed at real
 * features instead of guessed coordinates. Also reports the steepest cell,
 * which is where cliff-focused captures want to point.
 */
const seed = DEFAULT_TERRAIN_CONFIG.seed
const step = Number(process.argv[2] ?? 128)
const range = Number(process.argv[3] ?? 1536)

let minimum = Infinity
let maximum = -Infinity
let peak = { x: 0, z: 0, height: -Infinity }
let steepest = { x: 0, z: 0, slope: 0 }
const rows: string[] = []

for (let z = -range; z <= range; z += step) {
  const cells: string[] = []
  for (let x = -range; x <= range; x += step) {
    const sample = sampleHeightField(x, z, seed)
    minimum = Math.min(minimum, sample.height)
    maximum = Math.max(maximum, sample.height)
    if (sample.height > peak.height) peak = { x, z, height: sample.height }
    const gradient = Math.hypot(
      sampleHeightField(x + 8, z, seed).height - sampleHeightField(x - 8, z, seed).height,
      sampleHeightField(x, z + 8, seed).height - sampleHeightField(x, z - 8, seed).height,
    ) / 16
    if (gradient > steepest.slope) steepest = { x, z, slope: gradient }
    cells.push(String(Math.round(sample.height)).padStart(5))
  }
  rows.push(`z=${String(z).padStart(6)} ${cells.join('')}`)
}

console.log(rows.join('\n'))
console.log(
  `min ${minimum.toFixed(0)}  max ${maximum.toFixed(0)}  ` +
    `peak ${JSON.stringify(peak)}  steepest ${JSON.stringify(steepest)}`,
)
