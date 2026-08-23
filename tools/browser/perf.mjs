// Browser performance harness.
//
// Companion to shot.mjs: where that one asks what a frame looks like, this asks
// what it costs. It drives the real editor in real Chrome with real WebGPU and
// reports three things that are easy to confuse with each other:
//
//   startup   how long streaming takes to go quiet, and what it settled on
//   idle      frame cost with the pointer still
//   hover     frame cost while the pointer sweeps the viewport
//
// The split matters because the editor casts a ray and updates the 3D cursor on
// every hover frame, so hover can be several times more expensive than idle on
// exactly the same scene. A single "fps" number hides that, and will happily
// report an improvement that is really a build streaming fewer sections -- so
// always read `visibleSections` and `triangles` alongside the frame costs, and
// distrust any comparison where those two do not match.
//
//   node tools/browser/perf.mjs --label=after
//
// Requires the dev server (`bun run dev`) to be up on --url.
import { chromium } from 'playwright'

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=')
    return [key, value]
  }),
)

const options = {
  label: flags.get('label') ?? 'run',
  url: flags.get('url') ?? 'http://localhost:5173',
  quality: flags.get('quality') ?? 'preview',
  width: Number(flags.get('width') ?? 1400),
  height: Number(flags.get('height') ?? 800),
  windowMs: Number(flags.get('window') ?? 4000),
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  // Playwright's defaults disable the GPU, which leaves navigator.gpu
  // undefined and the app refusing to start.
  ignoreDefaultArgs: [
    '--disable-gpu',
    '--use-gl=swiftshader',
    '--disable-software-rasterizer',
    '--disable-gpu-compositing',
  ],
  args: ['--enable-unsafe-webgpu', '--hide-scrollbars'],
})
const page = await browser.newPage({
  viewport: { width: options.width, height: options.height },
  deviceScaleFactor: 1,
})
const problems = []
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text())
})
page.on('pageerror', (error) => problems.push(String(error)))

// Always the shipped scene, never whatever this browser profile cached.
const query = new URLSearchParams({ quality: options.quality, reset: '1' })
await page.goto(`${options.url}/?${query}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })

const pollSettled = async () =>
  page.evaluate(async () => {
    const started = performance.now()
    let quietSince = 0
    let last = null
    let firstVisibleAt = 0
    const timeline = []
    while (performance.now() - started < 240_000) {
      const metrics = globalThis.__meshterrain?.terrain?.metrics?.getSnapshot?.()
      if (metrics) {
        last = metrics
        if (!firstVisibleAt && metrics.visibleSections > 0) {
          firstVisibleAt = performance.now()
        }
        // Residency is not all-or-nothing and the endpoint alone hides that:
        // nearest-first priority means the view is usable long before the last
        // distant cell lands. The curve is what shows whether a longer settle
        // is a slower start or simply a larger map still filling in behind one.
        const elapsed = Math.round(performance.now() - started)
        if (!timeline.length || elapsed - timeline[timeline.length - 1].ms >= 1000) {
          timeline.push({
            ms: elapsed,
            sections: metrics.visibleSections,
            triangles: metrics.trianglesRendered,
            wq: metrics.workerQueuedJobs,
            wa: metrics.workerActiveJobs,
            swapped: metrics.sectionsSwapped,
            rebuilding: metrics.sectionsRebuilding,
            queue: globalThis.__meshterrain?.terrain?.scheduler?.pendingTaskCount ?? -1,
          })
        }
        const busy =
          metrics.workerQueuedJobs > 0 ||
          metrics.workerActiveJobs > 0 ||
          metrics.sectionsRebuilding > 0 ||
          metrics.visibleSections === 0
        if (busy) quietSince = 0
        else if (!quietSince) quietSince = performance.now()
        else if (performance.now() - quietSince > 2500) break
      }
      await new Promise((done) => setTimeout(done, 100))
    }
    return {
      settleMs: Math.round(performance.now() - started - 2500),
      firstVisibleMs: Math.round(firstVisibleAt - started),
      visibleSections: last?.visibleSections ?? 0,
      triangles: last?.trianglesRendered ?? 0,
      trianglesByLod: last?.trianglesByLod ?? [],
      frameBudgetViolations: last?.frameBudgetViolations ?? 0,
      compileP50Ms: Math.round(last?.compileP50Ms ?? 0),
      compileP95Ms: Math.round(last?.compileP95Ms ?? 0),
      cpuMb: +((last?.cpuBytes ?? 0) / 1048576).toFixed(1),
      gpuMb: +((last?.gpuBytes ?? 0) / 1048576).toFixed(1),
      timeline,
    }
  })

// Vite's dependency optimiser reloads the page the first time it runs, which
// tears down the evaluation context mid-poll. One retry rides that out.
let settled
try {
  settled = await pollSettled()
} catch (error) {
  if (!String(error).includes('Execution context was destroyed')) throw error
  await page.waitForSelector('canvas', { timeout: 60_000 })
  settled = await pollSettled()
}

// A settled scene is a prerequisite for both windows below: compile and upload
// work still in flight would be charged to whichever one happened to be running.
const frames = await page.evaluate(async (windowMs) => {
  const canvas = document.querySelector('canvas')
  const bounds = canvas.getBoundingClientRect()
  const samples = []
  let previous = performance.now()
  let running = true
  const tick = () => {
    const now = performance.now()
    samples.push(now - previous)
    previous = now
    if (running) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const summarise = () => {
    const sorted = [...samples].sort((a, b) => a - b)
    return {
      samples: sorted.length,
      median: +sorted[sorted.length >> 1].toFixed(2),
      p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      worst: +sorted[sorted.length - 1].toFixed(2),
      fps: Math.round(1000 / sorted[sorted.length >> 1]),
    }
  }
  const hover = (x, y) =>
    canvas.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerId: 1,
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        button: -1,
        buttons: 0,
        clientX: bounds.left + x,
        clientY: bounds.top + y,
        pointerType: 'mouse',
      }),
    )

  await new Promise((done) => setTimeout(done, 400))
  samples.length = 0
  await new Promise((done) => setTimeout(done, windowMs))
  const idle = summarise()

  // One cast first, then a pause. Raycast acceleration structures are built on
  // first use, and that one-off belongs to neither window.
  hover(bounds.width * 0.5, bounds.height * 0.5)
  await new Promise((done) => setTimeout(done, 1200))
  samples.length = 0
  const started = performance.now()
  let casts = 0
  while (performance.now() - started < windowMs) {
    const step = casts++
    hover(
      bounds.width * 0.2 + ((step * 13) % (bounds.width * 0.6)),
      bounds.height * 0.35 + Math.sin(step / 9) * bounds.height * 0.2,
    )
    await new Promise((done) => setTimeout(done, 4))
  }
  const moving = summarise()
  running = false
  // `casts` is part of the result on purpose: a build that drops pointer work
  // looks fast here, and the cast count is what gives it away.
  return { idle, hover: moving, casts }
}, options.windowMs)

console.log(
  JSON.stringify(
    { label: options.label, ...settled, frames, problems: problems.slice(0, 6) },
    null,
    2,
  ),
)
await browser.close()
