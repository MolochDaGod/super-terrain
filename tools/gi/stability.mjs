// Measures temporal stability of the GI rig instead of judging it from a still.
//
// A frame-to-frame flicker figure is the only honest way to answer "does it
// still crawl?" — a converged screenshot looks identical whether the previous
// frame matched it or not. Two regimes are reported: a parked camera (pure
// estimator noise) and a camera panning through the scene (cascade scrolling,
// probe rejection, reprojection).
//
//   node tools/gi/stability.mjs --url=http://localhost:5173/gi.html
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { decodePng } from '../browser/pngStats.mjs'
import { encodePng } from './encodePng.mjs'

const flags = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)

const options = {
  url: flags.get('url') ?? 'http://localhost:5173/gi.html',
  width: Number(flags.get('width') ?? 960),
  height: Number(flags.get('height') ?? 560),
  frames: Number(flags.get('frames') ?? 12),
  settleMs: Number(flags.get('settle') ?? 9000),
  out: flags.get('out') ?? 'captures/gi',
  name: flags.get('name') ?? 'stability',
}

const query = new URLSearchParams()
for (const [k, v] of flags) {
  if (['url', 'width', 'height', 'frames', 'settle', 'out', 'name'].includes(k)) continue
  query.set(k, v)
}
const target = query.size ? `${options.url}?${query}` : options.url

mkdirSync(resolve(options.out), { recursive: true })

/** Mean absolute luma difference, in 0-255 units, ignoring the HUD corner. */
function flicker(a, b) {
  const { width, height, channels, pixels: pa } = a
  const pb = b.pixels
  // The HUD repaints its fps figure twice a second; counting it would report
  // text as flicker.
  const hudW = Math.floor(width * 0.45)
  const hudH = Math.floor(height * 0.2)
  let sum = 0
  let peak = 0
  let n = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < hudW && y < hudH) continue
      const i = (y * width + x) * channels
      const la = pa[i] * 0.299 + pa[i + 1] * 0.587 + pa[i + 2] * 0.114
      const lb = pb[i] * 0.299 + pb[i + 1] * 0.587 + pb[i + 2] * 0.114
      const d = Math.abs(la - lb)
      sum += d
      if (d > peak) peak = d
      n += 1
    }
  }
  return { mean: sum / n, peak }
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: options.width, height: options.height } })
const logs = []
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') logs.push(`[error] ${m.text()}`)
})

await page.goto(target, { waitUntil: 'load', timeout: 240_000 })
await page.waitForFunction(
  () => /fps/.test(document.querySelector('#hud')?.textContent ?? ''),
  { timeout: 240_000 },
)
await page.waitForTimeout(options.settleMs)

/** Amplified absolute difference, so localised popping is visible at all. */
function diffImage(a, b, gain = 6) {
  const { width, height, channels, pixels: pa } = a
  const pb = b.pixels
  const out = new Uint8Array(width * height * 4)
  for (let i = 0, o = 0; o < out.length; i += channels, o += 4) {
    out[o] = Math.min(255, Math.abs(pa[i] - pb[i]) * gain)
    out[o + 1] = Math.min(255, Math.abs(pa[i + 1] - pb[i + 1]) * gain)
    out[o + 2] = Math.min(255, Math.abs(pa[i + 2] - pb[i + 2]) * gain)
    out[o + 3] = 255
  }
  return { width, height, data: out }
}

async function series(label, before) {
  const shots = []
  for (let i = 0; i < options.frames; i += 1) {
    if (before) await before(i)
    shots.push(decodePng(await page.screenshot()))
  }
  const stats = []
  for (let i = 1; i < shots.length; i += 1) {
    stats.push(flicker(shots[i - 1], shots[i]))
  }
  const mean = stats.reduce((s, v) => s + v.mean, 0) / stats.length
  const peak = Math.max(...stats.map((v) => v.peak))
  const worst = stats.reduce((best, v, i) => (v.peak > stats[best].peak ? i : best), 0)
  const diff = diffImage(shots[worst], shots[worst + 1])
  writeFileSync(
    resolve(options.out, `${options.name}-${label}-diff.png`),
    encodePng(diff.data, diff.width, diff.height),
  )
  return { label, mean, peak, first: shots[0], last: shots[shots.length - 1] }
}

const parked = await series('parked', null)

// Orbit the camera a little between frames: exercises cascade scrolling.
const drag = async (i) => {
  await page.mouse.move(options.width * 0.5, options.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(options.width * 0.5 + 6 * (i + 1), options.height * 0.5, { steps: 2 })
  await page.mouse.up()
  await page.waitForTimeout(90)
}
const moving = await series('orbiting', drag)

const report = [
  target,
  await page.evaluate(() => document.querySelector('#hud')?.textContent ?? ''),
  '',
  'frame-to-frame luma difference (0-255), HUD corner excluded',
  `  parked    mean ${parked.mean.toFixed(3)}  peak ${parked.peak.toFixed(1)}`,
  `  orbiting  mean ${moving.mean.toFixed(3)}  peak ${moving.peak.toFixed(1)}`,
  '',
  'a parked mean above ~0.5 is visible shimmer; peak flags localised popping',
  ...logs,
].join('\n')

writeFileSync(resolve(options.out, `${options.name}.log`), report + '\n')
await page.screenshot({ path: resolve(options.out, `${options.name}.png`) })
console.log(report)
await browser.close()
