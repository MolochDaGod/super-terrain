import { chromium } from 'playwright'
const OUT = '/private/tmp/claude-502/-Users-fairhat-Repositories-meshterrain/4eb93ed2-d785-46ae-97d6-1c83060be02c/scratchpad'
const url = 'http://localhost:5174/?ui=off&quality=full&reset=1'
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  ignoreDefaultArgs: ['--disable-gpu','--use-gl=swiftshader','--disable-software-rasterizer','--disable-gpu-compositing'],
  args: ['--enable-unsafe-webgpu','--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
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
await page.screenshot({ path: `${OUT}/csm-0-baseline.png` })

// Experiment A: widen the cascade shadow camera depth range.
console.log(await page.evaluate(() => {
  const { scene } = globalThis.__meshterrainScene
  let sun = null; scene.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o })
  const node = sun.shadow.shadowNode
  for (const l of node.lights) {
    l.shadow.camera.near = 1
    l.shadow.camera.far = 6000
    l.shadow.camera.updateProjectionMatrix()
    l.shadow.needsUpdate = true
  }
  return 'far widened'
}))
await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT}/csm-1-far.png` })

// Experiment B: also rebind the CSM to the live scene camera.
console.log(await page.evaluate(() => {
  const { scene, camera } = globalThis.__meshterrainScene
  let sun = null; scene.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o })
  const node = sun.shadow.shadowNode
  const was = node.camera.uuid
  node.camera = camera
  node.updateFrustums()
  for (const l of node.lights) { l.shadow.camera.near = 1; l.shadow.camera.far = 6000; l.shadow.camera.updateProjectionMatrix(); l.shadow.needsUpdate = true }
  return `rebound ${was} -> ${camera.uuid}`
}))
await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT}/csm-2-camera.png` })
await browser.close()
