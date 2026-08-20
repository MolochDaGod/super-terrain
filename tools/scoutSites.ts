/**
 * Finds candidate hero sites in the procedural world.
 *
 * The height field is a closed-form function, so the whole world can be probed
 * far faster than it can be rendered. This scores every candidate on what the
 * hero frame needs: an alpine (non-arid) climate, a high massif, strong local
 * relief for a real silhouette, and a valley floor in front of the viewpoint
 * for the mist and the river to sit in.
 *
 *   bun run tools/scoutSites.ts
 */
import { sampleHeightField } from '../src/terrain/compiler/heightField'
import { DEFAULT_TERRAIN_CONFIG } from '../src/terrain/config'

const NEIGHBOURS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
]

const seed = DEFAULT_TERRAIN_CONFIG.seed
const half = DEFAULT_TERRAIN_CONFIG.worldSize / 2
const step = 64

interface Site {
  x: number
  z: number
  height: number
  massif: number
  aridity: number
  relief: number
  valleyDrop: number
  score: number
}

const sites: Site[] = []
for (let z = -half + step; z < half - step; z += step) {
  for (let x = -half + step; x < half - step; x += step) {
    const sample = sampleHeightField(x, z, seed)
    if (sample.massif < 0.45) continue
    let lowest = sample.height
    let highest = sample.height
    for (const [dx, dz] of NEIGHBOURS) {
      const neighbour = sampleHeightField(x + dx * 220, z + dz * 220, seed)
      lowest = Math.min(lowest, neighbour.height)
      highest = Math.max(highest, neighbour.height)
    }
    const relief = highest - lowest
    const valleyDrop = sample.height - lowest
    const score =
      relief * 0.6 +
      valleyDrop * 0.5 +
      sample.massif * 220 -
      sample.aridity * 900
    sites.push({
      x,
      z,
      height: sample.height,
      massif: sample.massif,
      aridity: sample.aridity,
      relief,
      valleyDrop,
      score,
    })
  }
}

sites.sort((a, b) => b.score - a.score)
console.log('top hero-site candidates (peak, and the valley floor beside it):')
for (const site of sites.slice(0, 14)) {
  console.log(
    `x ${String(Math.round(site.x)).padStart(6)}  z ${String(Math.round(site.z)).padStart(6)}  ` +
      `height ${site.height.toFixed(0).padStart(5)}  relief ${site.relief.toFixed(0).padStart(4)}  ` +
      `massif ${site.massif.toFixed(2)}  aridity ${site.aridity.toFixed(2)}  ` +
      `score ${site.score.toFixed(0)}`,
  )
}

