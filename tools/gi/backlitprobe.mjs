// Isolates the dark rim reported around foliage cards when shooting into the sun.
//
// Backlit foliage stacks several candidate causes on top of each other: the
// alpha-to-coverage edge band, the tangent normals along the cutout rim, and
// the alpha test itself. This shoots the same frame with each suspect disabled
// in turn, so the one that removes the artefact identifies it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const flags = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)
const url = flags.get('url') ?? 'http://localhost:5173'
const out = flags.get('out') ?? 'captures/gi'
const settleMs = Number(flags.get('settle') ?? 95_000)

mkdirSync(resolve(out), { recursive: true })
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } })
page.setDefaultTimeout(180_000)
await page.goto(`${url}/?editor=tree&ui=off`, { waitUntil: 'load', timeout: 240_000 })
await page.waitForFunction(() => Boolean(globalThis.__meshtree?.store), { timeout: 240_000 })
await page.evaluate(() =>
  globalThis.__meshtree.store.generateForest({ forestPreset: 'mossy-old-growth' }))
await page.waitForTimeout(settleMs)

// Look into the sun, with the stand between camera and light.
const sun = await page.evaluate(() => {
  let direction = null
  globalThis.__meshtree.scene.traverse((o) => {
    if (o.isDirectionalLight && o.castShadow && !direction) {
      const p = o.getWorldPosition(new o.position.constructor())
      const t = o.target.getWorldPosition(new o.position.constructor())
      direction = p.sub(t).normalize().toArray()
    }
  })
  if (!direction) return null
  const { camera, controls } = globalThis.__meshtree
  // Stand behind the trees relative to the sun, aiming through them at it.
  const eye = [-direction[0] * 34, 3.2, -direction[2] * 34]
  camera.position.set(eye[0], eye[1], eye[2])
  controls?.target.set(direction[0] * 30, 3.2 + direction[1] * 26, direction[2] * 30)
  controls?.update()
  camera.updateMatrixWorld()
  return { direction, eye }
})
console.log('sun', JSON.stringify(sun))
await page.waitForTimeout(3000)

const leafMaterials = () => page.evaluate(() => {
  const list = []
  globalThis.__meshtree.scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
    for (const m of mats) if (/leaf spray card/.test(m.name ?? '')) list.push(m)
  })
  globalThis.__leafMats = list
  return list.length
})
console.log('leaf materials:', await leafMaterials())

async function shoot(name) {
  await page.waitForTimeout(2500)
  await page.screenshot({ path: resolve(out, `backlit-${name}.png`) })
  console.log('wrote', name)
}

await shoot('baseline')

const apply = (fn) => page.evaluate(`(${fn})()`)

await apply(`() => { for (const m of globalThis.__leafMats) { m.__a2c = m.alphaToCoverage; m.alphaToCoverage = false; m.needsUpdate = true } }`)
await shoot('no-a2c')
await apply(`() => { for (const m of globalThis.__leafMats) { m.alphaToCoverage = m.__a2c; m.needsUpdate = true } }`)

await apply(`() => { for (const m of globalThis.__leafMats) { m.__ns = m.normalScale?.clone?.(); m.normalScale?.set(0, 0); m.needsUpdate = true } }`)
await shoot('no-normalmap')
await apply(`() => { for (const m of globalThis.__leafMats) { if (m.__ns) m.normalScale.copy(m.__ns); m.needsUpdate = true } }`)

await apply(`() => { for (const m of globalThis.__leafMats) { m.__at = m.alphaTest; m.alphaTest = 0.7; m.needsUpdate = true } }`)
await shoot('high-alphatest')
await apply(`() => { for (const m of globalThis.__leafMats) { m.alphaTest = m.__at; m.needsUpdate = true } }`)

await apply(`() => { for (const m of globalThis.__leafMats) { m.__side = m.side; m.side = 0; m.needsUpdate = true } }`)
await shoot('frontside')
await apply(`() => { for (const m of globalThis.__leafMats) { m.side = m.__side; m.needsUpdate = true } }`)

await apply(`() => { globalThis.__meshtree.scene.traverse((o) => { if (o.isLight && o.castShadow) { o.__cs = true; o.castShadow = false } }) }`)
await shoot('no-shadowmap')

writeFileSync(resolve(out, 'backlit.log'), `${JSON.stringify(sun)}\n`)
await browser.close()
