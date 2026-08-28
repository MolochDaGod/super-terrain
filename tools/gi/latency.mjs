// How many frames the bounce takes to follow a light that jumps.
//
// Heavy temporal filtering is what makes the probe field quiet, and it is also
// what would make a moving lamp drag a stale pool of colour behind it. The two
// have to be measured together or tuning one silently wrecks the other.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { decodePng } from '../browser/pngStats.mjs'

const flags = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)
const url = flags.get('url') ?? 'http://localhost:5173/gi.html'
const out = flags.get('out') ?? 'captures/gi'
const name = flags.get('name') ?? 'latency'
const width = Number(flags.get('width') ?? 900)
const height = Number(flags.get('height') ?? 520)
const settleFrames = Number(flags.get('converge') ?? 90)

const query = new URLSearchParams({ freeze: '1' })
for (const [k, v] of flags) {
  if (['url', 'out', 'name', 'width', 'height', 'converge'].includes(k)) continue
  query.set(k, v)
}

mkdirSync(resolve(out), { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width, height } })
await page.goto(`${url}?${query}`, { waitUntil: 'load', timeout: 240_000 })
await page.waitForFunction(() => Boolean(globalThis.__demo), { timeout: 240_000 })
await page.waitForTimeout(9000)

const pin = (t) => page.evaluate((time) => globalThis.__demo.pinLampTime(time), t)
const settle = (frames) => page.waitForTimeout(frames * 17)

/** Mean absolute luma difference over the frame, HUD corner excluded. */
function distance(a, b) {
  const { width: w, height: h, channels, pixels: pa } = a
  const pb = b.pixels
  const hudW = Math.floor(w * 0.45)
  const hudH = Math.floor(h * 0.22)
  let sum = 0
  let n = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (x < hudW && y < hudH) continue
      const i = (y * w + x) * channels
      sum += Math.abs(
        (pa[i] * 0.299 + pa[i + 1] * 0.587 + pa[i + 2] * 0.114) -
          (pb[i] * 0.299 + pb[i + 1] * 0.587 + pb[i + 2] * 0.114),
      )
      n += 1
    }
  }
  return sum / n
}

// Converged reference for the destination lamp positions.
await pin(11)
await settle(settleFrames)
const converged = decodePng(await page.screenshot())

// Back to the start, settle, then jump and watch it catch up.
await pin(4.2)
await settle(settleFrames)
const before = decodePng(await page.screenshot())
const span = distance(before, converged)

await pin(11)
const samples = []
for (const frames of [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64]) {
  await settle(frames - (samples.at(-1)?.frames ?? 0))
  const shot = decodePng(await page.screenshot())
  const remaining = distance(shot, converged)
  samples.push({ frames, converged: 1 - remaining / Math.max(span, 1e-6) })
}

const to90 = samples.find((s) => s.converged >= 0.9)?.frames ?? '>64'
const report = [
  `${url}?${query}`,
  await page.evaluate(() => document.querySelector('#hud')?.textContent ?? ''),
  '',
  `lamp jump magnitude: ${span.toFixed(2)} mean luma`,
  ...samples.map((s) => `  after ${String(s.frames).padStart(3)} frames  ${(s.converged * 100).toFixed(1)}% converged`),
  '',
  `frames to 90%: ${to90}  (~${typeof to90 === 'number' ? (to90 / 60).toFixed(2) : '?'} s at 60 Hz)`,
].join('\n')

writeFileSync(resolve(out, `${name}.log`), report + '\n')
console.log(report)
await browser.close()
