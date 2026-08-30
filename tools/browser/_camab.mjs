import { chromium } from 'playwright'
const OUT = '/private/tmp/claude-502/-Users-fairhat-Repositories-meshterrain/4eb93ed2-d785-46ae-97d6-1c83060be02c/scratchpad'
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  ignoreDefaultArgs: ['--disable-gpu','--use-gl=swiftshader','--disable-software-rasterizer','--disable-gpu-compositing'],
  args: ['--enable-unsafe-webgpu','--hide-scrollbars'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } })
await page.goto('http://localhost:5174/?ui=off&quality=full&reset=1', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })
await page.waitForTimeout(22000)
// widen far only
await page.evaluate(() => {
  const { scene } = globalThis.__meshterrainScene
  let sun = null; scene.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o })
  for (const l of sun.shadow.shadowNode.lights) { l.shadow.camera.near = 1; l.shadow.camera.far = 6000; l.shadow.camera.updateProjectionMatrix(); l.shadow.needsUpdate = true }
})
await page.evaluate(() => globalThis.__meshterrainScene.placeCamera([260, 210, 320], [0, 40, 0]))
await page.waitForTimeout(6000)
console.log(JSON.stringify(await page.evaluate(() => {
  const { scene, camera } = globalThis.__meshterrainScene
  let sun = null; scene.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o })
  const n = sun.shadow.shadowNode
  return { scenePos: camera.position.toArray().map(v=>+v.toFixed(1)), csmPos: n.camera.position.toArray().map(v=>+v.toFixed(1)), same: n.camera === camera }
})))
await page.screenshot({ path: `${OUT}/ab-1-stalecam.png` })
await page.evaluate(() => {
  const { scene, camera } = globalThis.__meshterrainScene
  let sun = null; scene.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o })
  const n = sun.shadow.shadowNode
  n.camera = camera; n.updateFrustums()
  for (const l of n.lights) { l.shadow.camera.near = 1; l.shadow.camera.far = 6000; l.shadow.camera.updateProjectionMatrix(); l.shadow.needsUpdate = true }
})
await page.waitForTimeout(4000)
await page.screenshot({ path: `${OUT}/ab-2-livecam.png` })
await browser.close()
