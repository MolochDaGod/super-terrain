import { chromium } from 'playwright'
const url = 'http://localhost:5174/?ui=off&quality=full&reset=1'
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  ignoreDefaultArgs: ['--disable-gpu','--use-gl=swiftshader','--disable-software-rasterizer','--disable-gpu-compositing'],
  args: ['--enable-unsafe-webgpu','--hide-scrollbars'] })
const page = await browser.newPage({ viewport: { width: 900, height: 560 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })
await page.waitForTimeout(20000)
const read = () => page.evaluate(() => {
  const { scene, camera } = globalThis.__meshterrainScene
  let sun = null; scene.traverse((o) => { if (!sun && o.isDirectionalLight && o.castShadow) sun = o })
  const n = sun.shadow.shadowNode
  const cams = []
  scene.traverse((o) => { if (o.isCamera) cams.push({ uuid: o.uuid, type: o.type, name: o.name, pos: o.position.toArray().map(v=>+v.toFixed(1)) }) })
  return {
    scene: { uuid: camera.uuid, pos: camera.position.toArray().map(v=>+v.toFixed(1)), mw: camera.matrixWorld.elements.slice(12,15).map(v=>+v.toFixed(1)) },
    csm: { uuid: n.camera.uuid, pos: n.camera.position.toArray().map(v=>+v.toFixed(1)), mw: n.camera.matrixWorld.elements.slice(12,15).map(v=>+v.toFixed(1)), near: n.camera.near, far: n.camera.far },
    same: n.camera === camera,
    camerasInScene: cams,
  }
})
console.log('before move', JSON.stringify(await read()))
await page.evaluate(() => globalThis.__meshterrainScene.placeCamera([400, 300, 400], [0, 60, 0]))
await page.waitForTimeout(3000)
console.log('after move ', JSON.stringify(await read()))
await browser.close()
