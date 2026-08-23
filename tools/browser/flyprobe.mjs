// Moving-camera probe: what the editor costs while the user is actually flying.
import { chromium } from 'playwright'
const flags = new Map(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=')
  return [k, v]
}))
const label = flags.get('label') ?? 'run'
const speed = Number(flags.get('speed') ?? 140)  // metres per second
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  ignoreDefaultArgs: ['--disable-gpu','--use-gl=swiftshader','--disable-software-rasterizer','--disable-gpu-compositing'],
  args: ['--enable-unsafe-webgpu','--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: 1 })
const problems = []
page.on('pageerror', (e) => problems.push(String(e)))
await page.goto(`http://localhost:5173/?ui=off&reset=1&quality=${flags.get('quality') ?? 'preview'}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })
const wait = (ms) => new Promise((d) => setTimeout(d, ms))
const settle = () => page.evaluate(async () => {
  const started = performance.now()
  let quiet = 0
  while (performance.now() - started < 240_000) {
    const m = globalThis.__meshterrain?.terrain?.metrics?.getSnapshot?.()
    if (m) {
      const busy = m.workerQueuedJobs > 0 || m.workerActiveJobs > 0 || m.sectionsRebuilding > 0 || m.visibleSections === 0
      if (busy) quiet = 0
      else if (!quiet) quiet = performance.now()
      else if (performance.now() - quiet > 2000) break
    }
    await new Promise((d) => setTimeout(d, 150))
  }
  return Math.round(performance.now() - started)
})
await settle()
await wait(4000)

// Fly a long straight line across the map at a constant speed, the way a user
// pans to somewhere else, then stop and time how long the view in front takes
// to reach its final detail.
const client = await page.context().newCDPSession(page)
await client.send('Profiler.enable')
await client.send('Profiler.setSamplingInterval', { interval: 150 })
await client.send('Profiler.start')
const flight = await page.evaluate(async ([speed]) => {
  const terrain = globalThis.__meshterrain.terrain
  const camera = globalThis.__meshterrainScene.camera
  const samples = []
  const timeline = []
  const start = { x: -1500, z: -1500 }
  const end = { x: 1500, z: 1500 }
  const length = Math.hypot(end.x - start.x, end.z - start.z)
  const durationMs = (length / speed) * 1000
  const height = 220
  camera.position.set(start.x, terrain.sampleHeight(start.x, start.z) + height, start.z)
  terrain.setViewTarget({ x: start.x, y: 0, z: start.z })
  await new Promise((d) => setTimeout(d, 1500))

  const path = []
  for (let step = 0; step <= 200; step += 1) {
    const t = step / 200
    const x = start.x + (end.x - start.x) * t
    const z = start.z + (end.z - start.z) * t
    path.push(terrain.sampleHeight(x, z))
  }
  const groundAt = (t) => path[Math.min(path.length - 1, Math.round(t * 200))]

  const began = performance.now()
  let previous = began
  let lastSample = began
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now()
      samples.push(now - previous)
      previous = now
      const t = Math.min(1, (now - began) / durationMs)
      const x = start.x + (end.x - start.x) * t
      const z = start.z + (end.z - start.z) * t
      const ground = groundAt(t)
      camera.position.set(x, ground + height, z)
      const ahead = 260
      camera.lookAt(x + ahead * 0.7071, ground, z + ahead * 0.7071)
      terrain.setViewTarget({ x: x + ahead * 0.7071, y: ground, z: z + ahead * 0.7071 })
      if (now - lastSample > 500) {
        lastSample = now
        const m = terrain.metrics.getSnapshot()
        timeline.push({
          ms: Math.round(now - began), fps: Math.round(m.fps),
          sched: +m.terrainSchedulingMs.toFixed(1), main: +m.terrainMainThreadMs.toFixed(1),
          wq: m.workerQueuedJobs, wa: m.workerActiveJobs, reb: m.sectionsRebuilding,
          swaps: m.sectionsSwapped, tris: m.trianglesRendered,
          byLod: m.trianglesByLod.map((v) => Math.round(v / 1000)),
        })
      }
      if (t >= 1) done()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const stopped = performance.now()
  // How long the terrain in front of the camera takes to reach final detail
  // once the camera stops. Quiet has to be sustained: the frame the flight ends
  // on is quiet too, right up until the refinement pass notices.
  const atStop = terrain.metrics.getSnapshot()
  let quietSince = 0
  let settledAt = 0
  let fineAt = 0
  const finalise = []
  while (performance.now() - stopped < 90_000) {
    const m = terrain.metrics.getSnapshot()
    const now = performance.now()
    if (!fineAt && m.trianglesByLod[0] + m.trianglesByLod[1] > 40_000) fineAt = now
    if (finalise.length < 40 && (!finalise.length || now - finalise.at(-1).ms > 400)) {
      finalise.push({
        ms: Math.round(now - stopped), wq: m.workerQueuedJobs, wa: m.workerActiveJobs,
        byLod: m.trianglesByLod.map((v) => Math.round(v / 1000)),
      })
    }
    const busy = m.workerQueuedJobs > 0 || m.workerActiveJobs > 0 || m.sectionsRebuilding > 0
    if (busy) quietSince = 0
    else if (!quietSince) quietSince = now
    else if (now - quietSince > 1500) { settledAt = quietSince; break }
    await new Promise((d) => setTimeout(d, 100))
  }
  const sorted = samples.slice(10).sort((a, b) => a - b)
  return {
    flightMs: Math.round(stopped - began),
    detailAfterStopMs: settledAt ? Math.round(settledAt - stopped) : -1,
    fineDetailAfterStopMs: fineAt ? Math.round(fineAt - stopped) : -1,
    byLodAtStop: atStop.trianglesByLod.map((v) => Math.round(v / 1000)),
    byLodAtSettle: terrain.metrics.getSnapshot().trianglesByLod.map((v) => Math.round(v / 1000)),
    trisAtSettle: terrain.metrics.getSnapshot().trianglesRendered,
    gpuMbAtSettle: +(terrain.metrics.getSnapshot().gpuBytes / 1048576).toFixed(0),
    finalise,
    frames: {
      count: sorted.length,
      median: +sorted[sorted.length >> 1].toFixed(2),
      p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      p99: +sorted[Math.floor(sorted.length * 0.99)].toFixed(2),
      worst: +sorted[sorted.length - 1].toFixed(2),
      over33ms: sorted.filter((s) => s > 33).length,
      over100ms: sorted.filter((s) => s > 100).length,
    },
    timeline,
  }
}, [speed])
const { profile } = await client.send('Profiler.stop')
const total = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0) || 1
const by = new Map()
for (const node of profile.nodes) {
  const frame = node.callFrame
  const key = `${frame.functionName || '(anonymous)'} ${String(frame.url).split('/').slice(-1)[0]}:${frame.lineNumber}`
  by.set(key, (by.get(key) ?? 0) + (node.hitCount ?? 0))
}
const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  .map(([k, v]) => `${((v / total) * 100).toFixed(1)}%  ${k}`)
await page.screenshot({ path: `captures/ab/fly-${label}.png` })
console.log(JSON.stringify({ label, speed, ...flight, timeline: flight.timeline.slice(-3), problems: problems.slice(0, 5) }, null, 2))
console.log('\n== flight self time ==\n' + top.join('\n'))

// Ancestry of the heaviest frames, so a hot leaf can be traced to its caller.
const nodeById = new Map(profile.nodes.map((node) => [node.id, node]))
const parent = new Map()
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
const name = (node) => `${node.callFrame.functionName || '(anonymous)'} ${String(node.callFrame.url).split('/').slice(-1)[0]}:${node.callFrame.lineNumber}`
const heaviest = [...profile.nodes].sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0)).slice(0, 8)
console.log('\n== call paths ==')
for (const node of heaviest) {
  if (!node.hitCount) continue
  const chain = []
  let cursor = node.id
  while (cursor !== undefined && chain.length < 12) {
    chain.push(name(nodeById.get(cursor)))
    cursor = parent.get(cursor)
  }
  console.log(`${((node.hitCount / total) * 100).toFixed(1)}%  ` + chain.join('  <-  '))
}
await browser.close()
