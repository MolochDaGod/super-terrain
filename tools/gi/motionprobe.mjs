// Is the canopy moving, and is it moving as one object?
//
// A still frame cannot answer either question, and slow motion is exactly the
// kind that looks like nothing in a screenshot and like a bug in motion. This
// parks the camera, samples frames seconds apart, and reports how much of the
// image changed and how unevenly — a canopy sliding in lockstep and a canopy
// stirring produce very different numbers.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { decodePng } from '../browser/pngStats.mjs'
import { encodePng } from './encodePng.mjs'

const flags = new Map(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=')
  return [k, v]
}))
const url = flags.get('url') ?? 'http://localhost:5173'
const out = flags.get('out') ?? 'captures/gi'
const name = flags.get('name') ?? 'motion'
mkdirSync(resolve(out), { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } })
page.setDefaultTimeout(180_000)
await page.goto(`${url}/?editor=tree&ui=off`, { waitUntil: 'load', timeout: 240_000 })
await page.waitForFunction(() => Boolean(globalThis.__meshtree?.store), { timeout: 240_000 })
await page.evaluate(() =>
  globalThis.__meshtree.store.generateForest({ forestPreset: 'mossy-old-growth' }))
await page.waitForTimeout(Number(flags.get('settle') ?? 95_000))

await page.evaluate(() => {
  const { camera, controls } = globalThis.__meshtree
  camera.position.set(0, 6, 34)
  controls?.target.set(0, 11, 0)
  controls?.update()
  camera.updateMatrixWorld()
})
await page.waitForTimeout(3000)

const shots = []
for (const gap of [0, 1200, 2400, 4800]) {
  if (gap) await page.waitForTimeout(gap - (shots.at(-1)?.gap ?? 0))
  shots.push({ gap, image: decodePng(await page.screenshot()) })
}

/** Mean |Δ| and the spread of that difference across the frame's tiles. */
function motion(a, b) {
  const { width, height, channels, pixels: pa } = a
  const pb = b.pixels
  const tiles = 12
  const tileSums = new Float64Array(tiles * tiles)
  const tileCounts = new Float64Array(tiles * tiles)
  let sum = 0
  let n = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels
      const d = Math.abs(
        (pa[i] * 0.299 + pa[i + 1] * 0.587 + pa[i + 2] * 0.114) -
          (pb[i] * 0.299 + pb[i + 1] * 0.587 + pb[i + 2] * 0.114),
      )
      sum += d
      n += 1
      const tx = Math.min(tiles - 1, Math.floor((x / width) * tiles))
      const ty = Math.min(tiles - 1, Math.floor((y / height) * tiles))
      tileSums[ty * tiles + tx] += d
      tileCounts[ty * tiles + tx] += 1
    }
  }
  const mean = sum / n
  const tileMeans = [...tileSums].map((s, i) => s / Math.max(1, tileCounts[i]))
  const avg = tileMeans.reduce((s, v) => s + v, 0) / tileMeans.length
  const variance =
    tileMeans.reduce((s, v) => s + (v - avg) ** 2, 0) / tileMeans.length
  // Above ~0.35 means different parts of the canopy are doing different things.
  return { mean, unevenness: Math.sqrt(variance) / Math.max(avg, 1e-6) }
}

const lines = [`${name}  camera parked, canopy only`]
for (let i = 1; i < shots.length; i += 1) {
  const m = motion(shots[0].image, shots[i].image)
  lines.push(
    `  +${String(shots[i].gap).padStart(4)}ms  mean |Δluma| ${m.mean.toFixed(3)}  unevenness ${m.unevenness.toFixed(2)}`,
  )
}

const last = shots.at(-1).image
const first = shots[0].image
const diff = new Uint8Array(last.width * last.height * 4)
for (let i = 0, o = 0; o < diff.length; i += last.channels, o += 4) {
  const g = Math.min(255, Math.abs(last.pixels[i + 1] - first.pixels[i + 1]) * 8)
  diff[o] = Math.min(255, Math.abs(last.pixels[i] - first.pixels[i]) * 8)
  diff[o + 1] = g
  diff[o + 2] = Math.min(255, Math.abs(last.pixels[i + 2] - first.pixels[i + 2]) * 8)
  diff[o + 3] = 255
}
writeFileSync(resolve(out, `${name}-diff.png`), encodePng(diff, last.width, last.height))
writeFileSync(resolve(out, `${name}.png`), encodePng(toRgba(first), first.width, first.height))
function toRgba(image) {
  if (image.channels === 4) return image.pixels
  const o = new Uint8Array(image.width * image.height * 4)
  for (let i = 0, j = 0; j < o.length; i += image.channels, j += 4) {
    o[j] = image.pixels[i]; o[j + 1] = image.pixels[i + 1]
    o[j + 2] = image.pixels[i + 2]; o[j + 3] = 255
  }
  return o
}

const report = lines.join('\n')
writeFileSync(resolve(out, `${name}.log`), report + '\n')
console.log(report)
await browser.close()
