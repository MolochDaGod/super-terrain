// Frame-time sample for the forest workspace.
//
// Wind is vertex work on every leaf card in the stand, so "is it free?" has to
// be answered by timing the same stand from the same camera before and after,
// not by counting instructions.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const flags = new Map(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=')
  return [k, v]
}))
const url = flags.get('url') ?? 'http://localhost:5173'
const out = flags.get('out') ?? 'captures/gi'
const name = flags.get('name') ?? 'treeperf'
mkdirSync(resolve(out), { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } })
page.setDefaultTimeout(180_000)
await page.goto(`${url}/?editor=tree&ui=off`, { waitUntil: 'load', timeout: 240_000 })
await page.waitForFunction(() => Boolean(globalThis.__meshtree?.store), { timeout: 240_000 })
const radiusOverride = Number(flags.get('radius') ?? 0) || undefined
await page.evaluate((forestRadius) =>
  globalThis.__meshtree.store.generateForest({
    forestPreset: 'mossy-old-growth',
    ...(forestRadius ? { forestRadius } : {}),
  }), radiusOverride)
await page.waitForTimeout(Number(flags.get('settle') ?? 95_000))

// Inside the canopy, looking through it: the most leaf cards on screen.
await page.evaluate(() => {
  const { camera, controls } = globalThis.__meshtree
  camera.position.set(14, 5.5, 14)
  controls?.target.set(-6, 8, -6)
  controls?.update()
  camera.updateMatrixWorld()
})
await page.waitForTimeout(4000)

const stats = await page.evaluate(() => new Promise((done) => {
  const samples = []
  let previous = performance.now()
  const tick = () => {
    const now = performance.now()
    samples.push(now - previous)
    previous = now
    if (samples.length < 420) requestAnimationFrame(tick)
    else {
      // Drop the first second; pipeline builds and streaming settle in it.
      const warm = samples.slice(60).sort((a, b) => a - b)
      done({
        frames: warm.length,
        median: warm[Math.floor(warm.length / 2)],
        p95: warm[Math.floor(warm.length * 0.95)],
        min: warm[0],
      })
    }
  }
  requestAnimationFrame(tick)
}))

const report = `${name}  frames ${stats.frames}  median ${stats.median.toFixed(2)}ms  p95 ${stats.p95.toFixed(2)}ms  min ${stats.min.toFixed(2)}ms`
writeFileSync(resolve(out, `${name}.log`), report + '\n')
await page.screenshot({ path: resolve(out, `${name}.png`) })
console.log(report)
await browser.close()
