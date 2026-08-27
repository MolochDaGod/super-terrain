// Forest workspace review harness.
//
// Drives the real tree editor in real Chrome with real WebGPU, generates a
// forest through the live store, waits for every prototype to compile and warm
// its materials, then screenshots settled eye-level frames. It also reports
// build timings and every console error the run produced, which is how the
// WebGPU validation regressions are caught: they only appear on a real device
// under real batching.
//
//   node tools/browser/forestshot.mjs --preset=temperate-mixed --radius=45
//
// Requires the dev server on --url.
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=')
    return [key, value]
  }),
)

const options = {
  name: flags.get('name') ?? 'forest',
  url: flags.get('url') ?? 'http://localhost:5176',
  width: Number(flags.get('width') ?? 1400),
  height: Number(flags.get('height') ?? 933),
  out: flags.get('out') ?? 'captures/forest',
  preset: flags.get('preset') ?? 'temperate-mixed',
  seed: Number(flags.get('seed') ?? 42017),
  radius: Number(flags.get('radius') ?? 45),
  density: Number(flags.get('density') ?? 1),
  timeoutMs: Number(flags.get('timeout') ?? 600_000),
  shots: (flags.get('shots') ?? 'floor,depth,canopy').split(','),
  headless: flags.get('headless') === 'true',
}

// Eye-level viewpoints inside the stand. The reference is a photograph taken
// standing on the forest floor, so every review frame is too.
/**
 * Review viewpoints are derived from the layout, not hard-coded.
 *
 * A forest is regenerated from a seed, so a fixed camera position is inside a
 * trunk as soon as anything about the mix changes — and a frame photographed
 * from inside a bole is not evidence about anything. These stand in the
 * clearest spot within a band of the stand and look across it, which is where
 * a person would stand to take the reference photograph.
 */
function pickViews(placements, radius) {
  const stems = placements.filter((tree) => !tree.tilt)
  const clearance = (x, z) => {
    let nearest = Infinity
    for (const tree of stems) {
      nearest = Math.min(
        nearest,
        Math.hypot(tree.position[0] - x, tree.position[2] - z),
      )
    }
    return nearest
  }
  // How far the first ten metres of a look direction stay clear of a bole. A
  // spot with room to stand in is not the same thing as a spot with something
  // to look at: a camera a comfortable four metres from every trunk still
  // photographs solid bark if one of them is straight ahead.
  const openness = (x, z, heading) => {
    let worst = Infinity
    for (let step = 1; step <= 10; step += 1) {
      const px = x + Math.cos(heading) * step
      const pz = z + Math.sin(heading) * step
      worst = Math.min(worst, clearance(px, pz))
    }
    return worst
  }
  const views = []
  for (const [name, bearing, distance, fov, eye] of [
    ['floor', 0.6, 0.42, 44, 1.6],
    ['depth', 2.5, 0.55, 34, 1.75],
    ['canopy', 4.1, 0.3, 58, 1.5],
  ]) {
    let best = null
    for (let step = 0; step < 66; step += 1) {
      const angle = bearing + (step % 22) * 0.28
      const reach = radius * distance * (0.8 + ((step / 22) | 0) * 0.08)
      const x = Math.cos(angle) * reach
      const z = Math.sin(angle) * reach
      const open = clearance(x, z)
      if (open < 2.6) continue
      // Look back across the stand, then take the clearest heading near it.
      const inward = Math.atan2(-z, -x)
      for (let turn = -3; turn <= 3; turn += 1) {
        const heading = inward + turn * 0.26
        const view = openness(x, z, heading)
        if (!best || view > best.view) best = { x, z, heading, open, view }
      }
    }
    if (!best) best = { x: 0, z: 0, heading: 0, open: 0, view: 0 }
    const at = name === 'canopy'
      ? [best.x + Math.cos(best.heading) * 8, 15, best.z + Math.sin(best.heading) * 8]
      : [
          best.x + Math.cos(best.heading) * 14,
          eye + 0.3,
          best.z + Math.sin(best.heading) * 14,
        ]
    views.push({
      name,
      from: [best.x, eye, best.z],
      at,
      fov,
      clearance: best.open,
      openness: best.view,
    })
  }
  return views
}

mkdirSync(resolve(options.out), { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome',
  headless: options.headless,
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
page.on('crash', () => console.error('PAGE CRASHED — the renderer process died'))
const problems = []
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text())
})
page.on('pageerror', (error) => problems.push(String(error)))

const url = `${options.url}/?editor=tree&ui=off`
console.log(`opening ${url}`)
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })
await page.waitForFunction(() => Boolean(globalThis.__meshtree), null, { timeout: 60_000 })
await page.waitForTimeout(2_000)

const started = Date.now()
const layout = await page.evaluate(
  ({ preset, seed, radius, density }) => {
    const { store } = globalThis.__meshtree
    store.generateForest({
      forestPreset: preset,
      forestSeed: seed,
      forestRadius: radius,
      forestDensity: density,
    })
    const snapshot = store.getSnapshot()
    return {
      placements: snapshot.placements.length,
      prototypes: Object.keys(snapshot.prototypes).length,
    }
  },
  options,
)
console.log(`layout: ${layout.placements} trees · ${layout.prototypes} prototypes`)

const build = await page.evaluate(async (timeoutMs) => {
  const { store } = globalThis.__meshtree
  const begin = performance.now()
  const marks = []
  // Per-prototype spans separate the geometry compile from everything queued
  // around it; a single total hides which stage actually costs the wait.
  const spans = new Map()
  let done = 0
  while (performance.now() - begin < timeoutMs) {
    const snapshot = store.getSnapshot()
    const prototypes = Object.values(snapshot.prototypes)
    for (const prototype of prototypes) {
      const span = spans.get(prototype.id) ?? {}
      if (prototype.building && span.startedAt === undefined) {
        span.startedAt = Math.round(performance.now() - begin)
      }
      if (prototype.asset && span.readyAt === undefined) {
        span.readyAt = Math.round(performance.now() - begin)
      }
      spans.set(prototype.id, span)
    }
    const ready = prototypes.filter(
      (prototype) => prototype.asset && prototype.compiledRevision === prototype.buildRevision,
    )
    if (ready.length !== done) {
      done = ready.length
      marks.push({ ready: done, ms: Math.round(performance.now() - begin) })
    }
    if (ready.length === prototypes.length) {
      return {
        ms: Math.round(performance.now() - begin),
        marks,
        prototypes: prototypes.length,
        spans: [...spans].map(([id, span]) => ({ id, ...span })),
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { timedOut: true, marks, status: store.getSnapshot().status }
}, options.timeoutMs)

console.log(`build ${JSON.stringify(build)} (wall ${Date.now() - started}ms)`)

const bakeStats = await page.evaluate(() => globalThis.__treeTextureBakeStats?.() ?? [])
if (bakeStats.length > 0) {
  const byKind = {}
  for (const stat of bakeStats) {
    byKind[stat.kind] ??= { jobs: 0, totalMs: 0, maxMs: 0 }
    byKind[stat.kind].jobs += 1
    byKind[stat.kind].totalMs += stat.ms
    byKind[stat.kind].maxMs = Math.max(byKind[stat.kind].maxMs, stat.ms)
  }
  console.log(`bake jobs ${JSON.stringify(byKind)}`)
}

// Materials and pipelines land after the asset; give the warm-up its frames.
await page.waitForTimeout(6_000)

// Frame cost, measured in the same frame the screenshots come from. A capture
// harness that only reports whether a frame appeared cannot tell a forest that
// renders from one that the browser is barely surviving.
const fps = await page.evaluate(async () => {
  const frames = []
  let last = performance.now()
  await new Promise((done) => {
    let count = 0
    const tick = () => {
      const now = performance.now()
      frames.push(now - last)
      last = now
      count += 1
      if (count < 60) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  const sorted = [...frames].sort((a, b) => a - b)
  return {
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
    worstMs: Math.round(sorted[sorted.length - 1]),
  }
})
console.log(`frame ${JSON.stringify(fps)}`)

// Heap and retirement backlog. A forest that grows either without bound is a
// tab crash a few minutes later, which is not something a screenshot shows.
const health = await page.evaluate(() => ({
  heapMb: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1_048_576),
  backlog: globalThis.__meshtree.gpuRetirementBacklog?.() ?? -1,
}))
console.log(`health ${JSON.stringify(health)}`)

const written = []
const views = await page.evaluate(
  ({ radius }) => {
    const placements = globalThis.__meshtree.store.getSnapshot().placements
    return { placements: placements.map((p) => ({ position: p.position, tilt: p.tilt ?? 0 })), radius }
  },
  { radius: options.radius },
).then(({ placements, radius }) => pickViews(placements, radius))

for (const view of views) {
  if (!options.shots.includes(view.name)) continue
  await page.evaluate((view) => {
    const { camera, controls } = globalThis.__meshtree
    camera.fov = view.fov
    camera.near = 0.1
    camera.far = 60_000
    camera.position.set(view.from[0], view.from[1], view.from[2])
    camera.lookAt(view.at[0], view.at[1], view.at[2])
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    if (controls) {
      // Orbit damping re-clamps the camera to `maxPolarAngle` every frame,
      // which silently lifts an eye-level camera whose target is above it —
      // the exact framing a forest interior needs. Review drives the camera
      // directly, so the controller is switched off rather than fought.
      controls.enabled = false
      controls.target.set(view.at[0], view.at[1], view.at[2])
    }
  }, view)
  await page.waitForTimeout(1_500)
  const file = resolve(options.out, `${options.name}-${view.name}.png`)
  await page.screenshot({ path: file, timeout: 180_000 })
  written.push(file)
  console.log(
    `wrote ${file} (stood ${view.clearance.toFixed(1)}m clear, ` +
      `${view.openness.toFixed(1)}m of open sight line)`,
  )
}

// Orbit for a while: LOD reclassification, texture eviction and instance
// rebuilds are what actually trip the retirement path.
await page.evaluate(async () => {
  const { camera, controls } = globalThis.__meshtree
  for (let step = 0; step < 90; step += 1) {
    const angle = (step / 90) * Math.PI * 2
    const distance = 22 + Math.sin(angle * 3) * 16
    camera.position.set(Math.sin(angle) * distance, 1.7 + Math.sin(angle * 2) * 4, Math.cos(angle) * distance)
    camera.lookAt(0, 6, 0)
    camera.updateMatrixWorld(true)
    if (controls) { controls.enabled = false; controls.target.set(0, 6, 0) }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
})

if (problems.length > 0) {
  console.warn(`console errors (${problems.length}):\n  ${problems.slice(0, 12).join('\n  ')}`)
} else {
  console.log('no console errors')
}
await browser.close()
console.log(JSON.stringify({ build, layout, written, errors: problems.length }, null, 2))
