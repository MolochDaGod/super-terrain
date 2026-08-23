// A/B harness: same scene, same two cameras, before and after a change.
//
// Companion to shot.mjs (what a frame looks like) and perf.mjs (what a settled
// frame costs). This one exists for changes that are supposed to cost less
// without looking different, so it reports draw calls, object counts and frame
// cost next to a screenshot taken from a fixed viewpoint. Run it once on the
// change and once on a stash of it, then diff the two PNGs: a build that got
// faster by drawing less is exactly what the picture is there to catch.
//
//   node tools/browser/abshot.mjs --label=after
//
// The far camera waits out the far-field merge before sampling, since that is
// deliberately deferred maintenance rather than something a frame does eagerly.
// Requires the dev server (`bun run dev`) to be up.
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const flags = new Map(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=')
  return [k, v]
}))
const label = flags.get('label') ?? 'run'
const quality = flags.get('quality') ?? 'full'
mkdirSync('captures/ab', { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  ignoreDefaultArgs: ['--disable-gpu','--use-gl=swiftshader','--disable-software-rasterizer','--disable-gpu-compositing'],
  args: ['--enable-unsafe-webgpu','--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: 1 })
const problems = []
page.on('pageerror', (e) => problems.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })
await page.goto(`http://localhost:5173/?ui=off&reset=1&quality=${quality}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })

const wait = (ms) => new Promise((d) => setTimeout(d, ms))
const settle = async (maxMs) => page.evaluate(async (maxMs) => {
  const started = performance.now()
  let quiet = 0
  while (performance.now() - started < maxMs) {
    const m = globalThis.__meshterrain?.terrain?.metrics?.getSnapshot?.()
    if (m) {
      const busy = m.workerQueuedJobs > 0 || m.workerActiveJobs > 0 || m.sectionsRebuilding > 0 || m.visibleSections === 0
      if (busy) quiet = 0
      else if (!quiet) quiet = performance.now()
      else if (performance.now() - quiet > 2500) break
    }
    await wait0(200)
  }
  function wait0(ms) { return new Promise((d) => setTimeout(d, ms)) }
  return Math.round(performance.now() - started)
}, maxMs)

const place = (cam, target) => page.evaluate(([cam, target]) => {
  const c = globalThis.__meshterrainScene.camera
  const t = globalThis.__meshterrain.terrain
  c.position.set(...cam)
  c.lookAt(...target)
  c.updateMatrixWorld(true)
  t.setViewTarget({ x: target[0], y: target[1], z: target[2] })
}, [cam, target])

const report = () => page.evaluate(() => {
  const gl = globalThis.__meshterrainScene.gl
  const scene = globalThis.__meshterrainScene.scene
  const m = globalThis.__meshterrain.terrain.metrics.getSnapshot()
  let sectionMeshes = 0
  let batchMeshes = 0
  scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return
    if (o.name.startsWith('terrain-section')) sectionMeshes += 1
    if (o.name.startsWith('terrain-batch')) batchMeshes += 1
  })
  return {
    drawCalls: gl.info?.render?.drawCalls ?? -1,
    sectionMeshes, batchMeshes,
    fps: Math.round(m.fps), sched: +m.terrainSchedulingMs.toFixed(1),
    tris: m.trianglesRendered, vis: m.visibleSections,
    gpuMb: +(m.gpuBytes / 1048576).toFixed(0), cpuMb: +(m.cpuBytes / 1048576).toFixed(0),
    wq: m.workerQueuedJobs, wa: m.workerActiveJobs, reb: m.sectionsRebuilding,
  }
})

const frameStats = () => page.evaluate(() => new Promise((done) => {
  const samples = []
  let previous = performance.now()
  const tick = () => {
    const now = performance.now()
    samples.push(now - previous)
    previous = now
    if (samples.length < 180) requestAnimationFrame(tick)
    else {
      const sorted = samples.slice(5).sort((a, b) => a - b)
      done({
        median: +sorted[sorted.length >> 1].toFixed(2),
        p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
        fps: Math.round(1000 / sorted[sorted.length >> 1]),
      })
    }
  }
  requestAnimationFrame(tick)
}))

const settleMs = await settle(300_000)
const shots = {}
for (const [name, cam, target] of [
  ['near', [340, 150, 545], [340, 60, 245]],
  ['far', [0, 2400, 2400], [0, 0, 0]],
]) {
  await place(cam, target)
  await settle(300_000)
  await wait(10_000)
  shots[name] = { ...(await report()), frames: await frameStats() }
  await page.screenshot({ path: `captures/ab/${label}-${name}.png` })
}
console.log(JSON.stringify({ label, settleMs, ...shots, problems: problems.slice(0, 5) }, null, 2))
await browser.close()
