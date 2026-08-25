// Measures foliage in a captured frame.
//
// "Black backfaces", "plastic", "flat" and "too autumnal" are the four things a
// foliage review keeps arguing about by eye, and eyes disagree with themselves
// between sessions. Each is a statistic over the pixels that are actually
// foliage, so this pulls those pixels out of a real frame and reports them.
//
//   node tools/browser/foliageReport.mjs captures/tree/*.png
//
// It also fails loudly on a frame with no foliage in it at all, which is what a
// stalled WebGPU warm-up produces — a blank capture is easy to mistake for a
// regression and has cost a whole review cycle before.
import { readFileSync } from 'node:fs'
import { decodePng } from './pngStats.mjs'

/** Below this fraction of the frame, a capture is treated as having failed. */
const EMPTY_FRAME = 0.005

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node tools/browser/foliageReport.mjs <frame.png>...')
  process.exit(2)
}

let failed = false
for (const file of files) {
  const report = describeFoliage(decodePng(readFileSync(file)))
  const name = file.split('/').pop()
  if (report.coverage < EMPTY_FRAME) {
    console.log(`${name.padEnd(30)} NO FOLIAGE — capture failed or crown out of frame`)
    failed = true
    continue
  }
  console.log(
    `${name.padEnd(30)} cover ${pct(report.coverage)}  ` +
    `lum p10/p50/p90 ${f(report.lum[0])}/${f(report.lum[1])}/${f(report.lum[2])}  ` +
    `spread ${f(report.lum[2] - report.lum[0])}  ` +
    `sat p50 ${f(report.saturation)}  ` +
    `black ${pct(report.crushed)}  warm ${pct(report.warm)}`,
  )
}
process.exit(failed ? 1 : 0)

/**
 * Foliage is picked out by hue rather than by any mask the renderer could
 * provide, so the same measurement works on any frame from any harness.
 */
function describeFoliage(image) {
  const lum = []
  let crushed = 0
  let warm = 0
  const saturations = []
  const { width, height, channels, pixels: bytes } = image
  const pixels = width * height
  for (let index = 0; index < pixels; index += 1) {
    const r = bytes[index * channels] / 255
    const g = bytes[index * channels + 1] / 255
    const b = bytes[index * channels + 2] / 255
    // Green at least ties both other channels. Sky here is blue-dominant and
    // ground is red-dominant, so this isolates the canopy without a stencil —
    // and crucially it still catches a leaf that has gone black, where all
    // three channels collapse together. Requiring green to *lead* by a margin
    // silently drops exactly the crushed pixels the report exists to count.
    if (!(g >= r - 0.004 && g >= b - 0.004)) continue
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    lum.push(luminance)
    const peak = Math.max(r, g, b)
    saturations.push(peak <= 0 ? 0 : (peak - Math.min(r, g, b)) / peak)
    // Foliage this dark has lost its shading entirely: the black-cutout look.
    // Nothing else in this scene goes near black — the sky floor is far above
    // it and lit ground higher still — so it is a clean measure.
    if (luminance < 0.05) crushed += 1
    // Leaves that have gone browner than they are green.
    if (r > g * 0.94) warm += 1
  }
  if (lum.length === 0) return { coverage: 0 }
  lum.sort((a, b) => a - b)
  saturations.sort((a, b) => a - b)
  const at = (values, q) => values[Math.min(values.length - 1, Math.floor(q * values.length))]
  return {
    coverage: lum.length / pixels,
    lum: [at(lum, 0.1), at(lum, 0.5), at(lum, 0.9)],
    saturation: at(saturations, 0.5),
    crushed: crushed / lum.length,
    warm: warm / lum.length,
  }
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`.padStart(6)
}

function f(value) {
  return value.toFixed(3)
}
