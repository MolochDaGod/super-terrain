import { chromium } from 'playwright'
const OUT = '/private/tmp/claude-502/-Users-fairhat-Repositories-meshterrain/4eb93ed2-d785-46ae-97d6-1c83060be02c/scratchpad'
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  ignoreDefaultArgs: ['--disable-gpu','--use-gl=swiftshader','--disable-software-rasterizer','--disable-gpu-compositing'],
  args: ['--enable-unsafe-webgpu','--hide-scrollbars'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } })
const problems = []
page.on('pageerror', (e) => problems.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })
await page.goto('http://localhost:5174/?ui=off&quality=full&reset=1', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })
const poll = () => page.evaluate(async () => {
  const s = performance.now(); let q = 0
  while (performance.now() - s < 120_000) {
    const m = globalThis.__meshterrain?.terrain?.metrics?.getSnapshot?.()
    if (m) { const busy = m.workerQueuedJobs>0||m.workerActiveJobs>0||m.sectionsRebuilding>0||m.visibleSections===0
      if (busy) q=0; else if (q===0) q=performance.now(); else if (performance.now()-q>4000) break }
    await new Promise((r)=>setTimeout(r,250))
  }
})
try { await poll() } catch { await page.waitForSelector('canvas'); await poll() }
await page.evaluate(() => globalThis.__meshterrainScene.placeCamera([210, 120, 300], [0, 45, 0]))
await page.waitForTimeout(6000)
await page.screenshot({ path: `${OUT}/fix-on.png` })
await page.evaluate(() => globalThis.__meshterrain.editor.patch({ shadows: false }))
await page.waitForTimeout(8000)
await page.screenshot({ path: `${OUT}/fix-off.png` })
console.log(JSON.stringify(await page.evaluate(() => {
  const { scene } = globalThis.__meshterrainScene
  const suns = []
  scene.traverse((o) => { if (o.isDirectionalLight) suns.push({ i: o.intensity, cast: o.castShadow, node: !!o.shadow?.shadowNode }) })
  return { suns, shadows: globalThis.__meshterrain.editor.getSnapshot().shadows }
})))
await page.evaluate(() => globalThis.__meshterrain.editor.patch({ shadows: true }))
await page.waitForTimeout(8000)
await page.screenshot({ path: `${OUT}/fix-back-on.png` })
console.log('problems:', problems.slice(0, 10))
await browser.close()
