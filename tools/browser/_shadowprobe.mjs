import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://localhost:5174/?ui=off&quality=full&reset=1'
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  ignoreDefaultArgs: [
    '--disable-gpu', '--use-gl=swiftshader',
    '--disable-software-rasterizer', '--disable-gpu-compositing',
  ],
  args: ['--enable-unsafe-webgpu', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: 1 })
const problems = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()) })
page.on('pageerror', (e) => problems.push(String(e)))
console.log('opening', url)
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })

const poll = () => page.evaluate(async () => {
  const started = performance.now()
  let quiet = 0
  while (performance.now() - started < 120_000) {
    const m = globalThis.__meshterrain?.terrain?.metrics?.getSnapshot?.()
    if (m) {
      const busy = m.workerQueuedJobs > 0 || m.workerActiveJobs > 0 || m.sectionsRebuilding > 0 || m.visibleSections === 0
      if (busy) quiet = 0
      else if (quiet === 0) quiet = performance.now()
      else if (performance.now() - quiet > 4000) break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return performance.now() - started
})
try { await poll() } catch { await page.waitForSelector('canvas'); await poll() }

const probe = await page.evaluate(() => {
  const handle = globalThis.__meshterrainScene
  if (!handle) return { error: 'no scene handle' }
  const { gl, scene } = handle
  const lights = []
  const casters = new Map()
  scene.traverse((o) => {
    if (o.isLight) {
      lights.push({
        type: o.type, name: o.name, visible: o.visible, intensity: o.intensity,
        castShadow: !!o.castShadow,
        shadowNode: o.shadow?.shadowNode?.constructor?.name ?? null,
        autoUpdate: o.shadow?.autoUpdate, needsUpdate: o.shadow?.needsUpdate,
        mapSize: o.shadow ? [o.shadow.mapSize.width, o.shadow.mapSize.height] : null,
        hasMap: !!o.shadow?.map,
        intensityShadow: o.shadow?.intensity,
      })
    }
    if (o.isMesh) {
      const key = `${o.castShadow ? 'cast' : '----'}/${o.receiveShadow ? 'recv' : '----'}/${o.visible ? 'vis' : 'hid'}/${o.material?.type ?? '?'}`
      const e = casters.get(key) ?? { count: 0, sample: o.name || o.type }
      e.count += 1
      casters.set(key, e)
    }
  })
  return {
    shadowMap: { enabled: gl.shadowMap.enabled, type: gl.shadowMap.type, needsUpdate: gl.shadowMap.needsUpdate },
    lights,
    meshes: [...casters].map(([k, v]) => `${k} x${v.count} (${v.sample})`).sort(),
    shadowDebug: globalThis.__terrainShadowDebug ? globalThis.__terrainShadowDebug() : null,
  }
})
console.log(JSON.stringify(probe, null, 2))
console.log('--- console problems ---')
console.log(problems.slice(0, 30).join('\n'))
await page.screenshot({ path: process.argv[3] ?? '/private/tmp/claude-502/-Users-fairhat-Repositories-meshterrain/4eb93ed2-d785-46ae-97d6-1c83060be02c/scratchpad/terrain.png' })
await browser.close()
