// Browser visual-review harness.
//
// The headless capture tool in tools/capture renders through a different tone
// mapper, a different lighting setup and no streaming, so its frames are not
// evidence about what the editor shows. This drives the real app in real
// Chrome with real WebGPU and screenshots the settled frame.
//
//   node tools/browser/shot.mjs --name=hero --cam=..,..,.. --target=..,..,..
//
// Requires the dev server (`bun run dev`) to be up on --url.
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { describeExposure } from './pngStats.mjs'

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=')
    return [key, value]
  }),
)

const options = {
  name: flags.get('name') ?? 'shot',
  url: flags.get('url') ?? 'http://localhost:5173',
  cam: flags.get('cam'),
  target: flags.get('target'),
  fov: flags.get('fov'),
  quality: flags.get('quality') ?? 'full',
  width: Number(flags.get('width') ?? 1400),
  height: Number(flags.get('height') ?? 788),
  // Streaming keeps compiling for a while after the first frame; the settle
  // poll below normally ends the wait long before this cap.
  timeoutMs: Number(flags.get('timeout') ?? 180_000),
  settleMs: Number(flags.get('settle') ?? 4_000),
  // Metres above the terrain surface, applied to the camera after streaming
  // has settled. Guessing an absolute height puts the camera inside a hill as
  // often as not, and the authored caves make the heightfield alone a bad
  // guide.
  above: flags.has('above') ? Number(flags.get('above')) : undefined,
  out: flags.get('out') ?? 'captures/browser',
}

// Always from the shipped scene. A review frame taken against whatever this
// browser profile cached is a picture of an old build. `--keep-edits` opts out
// when the point of the frame is a world that was edited by hand.
const query = new URLSearchParams({ ui: 'off', quality: options.quality })
if (!flags.has('keep-edits')) query.set('reset', '1')
if (options.cam) query.set('cam', options.cam)
if (options.target) query.set('target', options.target)
if (options.fov) query.set('fov', options.fov)
for (const [key, value] of flags) {
  if (key.startsWith('x-')) query.set(key.slice(2), value)
}

mkdirSync(resolve(options.out), { recursive: true })

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

const url = `${options.url}/?${query.toString()}`
console.log(`opening ${url}`)
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })

const pollSettled = async () =>
  page.evaluate(async ({ timeoutMs, settleMs }) => {
  const handle = () => globalThis.__meshterrain
  const started = performance.now()
  let quietSince = 0
  let last = null
  while (performance.now() - started < timeoutMs) {
    const app = handle()
    const metrics = app?.terrain?.metrics?.getSnapshot?.()
    if (metrics) {
      last = metrics
      const busy =
        metrics.workerQueuedJobs > 0 ||
        metrics.workerActiveJobs > 0 ||
        metrics.sectionsRebuilding > 0 ||
        metrics.visibleSections === 0
      if (busy) quietSince = 0
      else if (quietSince === 0) quietSince = performance.now()
      else if (performance.now() - quietSince > settleMs) break
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  return {
    waitedMs: Math.round(performance.now() - started),
    visibleSections: last?.visibleSections ?? 0,
    triangles: last?.trianglesRendered ?? 0,
    fps: Math.round(last?.fps ?? 0),
  }
  }, options)

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

// What the frame was actually lit and graded with. Reading it back from the
// live scene is the only way to be sure the editor and any offline harness are
// describing the same render.
if (options.above !== undefined && options.cam) {
  const [x, , z] = options.cam.split(',').map(Number)
  const placement = await page.evaluate(
    ({ x, z, above }) => {
      const terrain = globalThis.__meshterrain?.terrain
      const camera = globalThis.__meshterrainScene?.camera
      if (!terrain || !camera) return null
      const ground = terrain.sampleHeight(x, z)
      camera.position.set(x, ground + above, z)
      camera.updateMatrixWorld(true)
      return { ground, y: ground + above }
    },
    { x, z, above: options.above },
  )
  if (placement) {
    console.log(
      `camera placed ${options.above}m above ground ${placement.ground.toFixed(0)}m` +
        ` -> y ${placement.y.toFixed(0)}m`,
    )
    // Moving the camera starts a new wave of streaming, and on a cold world
    // that wave is the *large* one — the first settle only ever covered the
    // sections around wherever the app happened to start. Waiting a fixed few
    // seconds here captures a half-built scene, or a blank one.
    settled = await pollSettled()
  }
}

const lighting = await page.evaluate(() => {
  const handle = globalThis.__meshterrainScene
  if (!handle) return null
  const { gl, scene, camera } = handle
  const lights = []
  scene.traverse((object) => {
    if (!object.isLight || !object.visible) return
    lights.push({
      type: object.type,
      intensity: object.intensity,
      colour: object.color?.getHexString?.() ?? null,
      castShadow: Boolean(object.castShadow),
      position: object.position ? object.position.toArray().map(Math.round) : null,
    })
  })
  return {
    lightingBackend: gl.userData?.clusteredWebgpuLighting
      ? 'clustered'
      : 'three-default',
    toneMapping: gl.toneMapping,
    exposure: gl.toneMappingExposure,
    shadows: gl.shadowMap?.enabled ?? null,
    shadowCasters: (() => {
      const counts = {}
      globalThis.__meshterrainScene.scene.traverse((object) => {
        if (!object.isMesh) return
        const group = object.name?.startsWith('terrain-section')
          ? 'terrain'
          : object.name || object.parent?.name || 'unnamed'
        counts[group] ??= { meshes: 0, casting: 0 }
        counts[group].meshes += 1
        if (object.castShadow) counts[group].casting += 1
      })
      return counts
    })(),
    lights,
    camera: {
      position: camera.position.toArray().map((value) => Math.round(value)),
      forward: camera
        .getWorldDirection(new (camera.position.constructor)())
        .toArray()
        .map((value) => Number(value.toFixed(2))),
      fov: camera.fov,
    },
  }
})

if (flags.has('rays')) {
  const rayPixels = flags.get('rays').split(';').map((entry) =>
    entry.split(',').map(Number),
  )
  const rayHits = await page.evaluate(
    ({ rayPixels, width, height }) => rayPixels.map(([x, y]) => ({
      pixel: [x, y],
      hits: globalThis.__meshterrainScene?.raycastPixel?.(x, y, width, height) ?? [],
    })),
    { rayPixels, width: options.width, height: options.height },
  )
  console.log(`rays: ${JSON.stringify(rayHits)}`)
}

const file = resolve(options.out, `${options.name}.png`)
// A WebGPU canvas only reaches the compositor when the page presents a frame,
// and this render loop can be down at a handful of frames a second while the
// last sections upload. Screenshotting on that schedule catches a surface that
// has not been presented to yet, and the result is a completely black PNG that
// looks exactly like a rendering bug. Keep the first frame that has any light
// in it at all.
let exposure
for (let attempt = 0; attempt < 4; attempt += 1) {
  await page.screenshot({ path: file })
  exposure = describeExposure(readFileSync(file))
  if (!/black 100\.0%/.test(exposure)) break
  await page.waitForTimeout(3_000)
}
console.log(`exposure: ${exposure}`)
console.log(
  `${options.name}: settled in ${settled.waitedMs}ms  ` +
    `${settled.visibleSections} sections  ${settled.triangles} tris  ` +
    `${settled.fps} fps -> ${file}`,
)
if (lighting) console.log(`lighting: ${JSON.stringify(lighting)}`)
if (problems.length > 0) {
  console.log(`page errors:\n  ${problems.slice(0, 8).join('\n  ')}`)
}
await browser.close()
