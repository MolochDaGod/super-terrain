import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:5174/?ui=off&quality=full&reset=1'
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  ignoreDefaultArgs: ['--disable-gpu','--use-gl=swiftshader','--disable-software-rasterizer','--disable-gpu-compositing'],
  args: ['--enable-unsafe-webgpu','--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })
const poll = () => page.evaluate(async () => {
  const started = performance.now()
  let quiet = 0
  while (performance.now() - started < 120_000) {
    const m = globalThis.__meshterrain?.terrain?.metrics?.getSnapshot?.()
    if (m) {
      const busy = m.workerQueuedJobs > 0 || m.workerActiveJobs > 0 || m.sectionsRebuilding > 0 || m.visibleSections === 0
      if (busy) quiet = 0; else if (quiet === 0) quiet = performance.now()
      else if (performance.now() - quiet > 4000) break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
})
try { await poll() } catch { await page.waitForSelector('canvas'); await poll() }

const out = await page.evaluate(() => {
  const { scene, camera } = globalThis.__meshterrainScene
  let sun = null
  scene.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o })
  const node = sun?.shadow?.shadowNode
  const desc = (c) => c ? {
    uuid: c.uuid, type: c.type, near: c.near, far: c.far,
    isOrtho: !!c.isOrthographicCamera, isPersp: !!c.isPerspectiveCamera,
    pos: c.position.toArray().map((v) => +v.toFixed(1)),
  } : null
  return {
    sceneCamera: desc(camera),
    csmCamera: desc(node?.camera),
    sameCamera: node?.camera === camera,
    breaks: node?.breaks,
    cascadesVec: node?._cascades?.map((v) => [v.x, v.y]),
    maxFar: node?.maxFar,
    lights: node?.lights?.map((l) => ({
      pos: l.position.toArray().map((v) => +v.toFixed(1)),
      targetPos: l.target.position.toArray().map((v) => +v.toFixed(1)),
      inScene: !!l.parent,
      cam: { left: l.shadow.camera.left, right: l.shadow.camera.right, near: l.shadow.camera.near, far: l.shadow.camera.far },
      hasMap: !!l.shadow.map,
      mapSize: [l.shadow.mapSize.width, l.shadow.mapSize.height],
      shadowNodeMap: !!l.shadow.shadowNode,
    })),
    shadowNodesMaps: node?._shadowNodes?.map((s) => ({ hasShadowMap: !!s.shadowMap, mapName: s.shadowMap?.texture?.name ?? null })),
  }
})
console.log(JSON.stringify(out, null, 2))
await browser.close()
