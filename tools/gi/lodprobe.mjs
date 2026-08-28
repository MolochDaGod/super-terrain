// Which material draws the black speckle in a backlit canopy?
//
// Tints each foliage material class a flat identifying colour and shoots the
// same backlit frame. Whatever the speckle turns into names the culprit, which
// beats reasoning about it from the shader source.
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const flags = new Map(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=')
  return [k, v]
}))
const url = flags.get('url') ?? 'http://localhost:5173'
const out = flags.get('out') ?? 'captures/gi'
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
await page.waitForTimeout(Number(flags.get('settle') ?? 95_000))

const info = await page.evaluate(() => {
  let dir = null
  globalThis.__meshtree.scene.traverse((o) => {
    if (o.isDirectionalLight && o.castShadow && !dir) {
      const p = o.getWorldPosition(o.position.clone())
      const t = o.target.getWorldPosition(o.position.clone())
      dir = p.sub(t).normalize()
    }
  })
  const { camera, controls } = globalThis.__meshtree
  // Outside the stand, low, aiming through it at the sun.
  camera.position.set(-dir.x * 62, 2.4, -dir.z * 62)
  controls?.target.set(dir.x * 20, 16, dir.z * 20)
  controls?.update()
  camera.updateMatrixWorld()

  const names = new Map()
  globalThis.__meshtree.scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
    for (const m of mats) names.set(m.name ?? '(unnamed)', (names.get(m.name ?? '(unnamed)') ?? 0) + 1)
  })
  return { dir: dir.toArray(), materials: [...names.entries()] }
})
console.log('sun', info.dir)
console.log('materials in scene:')
for (const [name, count] of info.materials) console.log(`  ${count}×  ${name}`)
await page.waitForTimeout(3000)
await page.screenshot({ path: resolve(out, 'lod-baseline.png') })

// Flat, unmistakable colours per class, ignoring lighting entirely.
const tint = (pattern, hex, name) => page.evaluate(([p, h]) => {
  let n = 0
  globalThis.__meshtree.scene.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
    for (const m of mats) {
      if (!new RegExp(p, 'i').test(m.name ?? '')) continue
      m.__savedColorNode = m.colorNode
      m.colorNode = null
      m.color?.setHex(h)
      m.emissive?.setHex(h)
      m.emissiveIntensity = 1
      m.needsUpdate = true
      n += 1
    }
  })
  return n
}, [pattern, hex]).then(async (n) => {
  console.log(`tinted ${n} ${name}`)
  await page.waitForTimeout(2500)
  await page.screenshot({ path: resolve(out, `lod-${name}.png`) })
})

// eslint-disable-next-line no-unused-vars
const toggle = (fn, name) => page.evaluate(`(${fn})()`).then(async (n) => {
  console.log(`${name}: ${n}`)
  await page.waitForTimeout(2500)
  await page.screenshot({ path: resolve(out, `lod-${name}.png`) })
})

await toggle(`() => { let n = 0; globalThis.__meshtree.scene.traverse((o) => { const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; for (const m of ms) if (/leaf spray card/.test(m.name ?? '')) { m.alphaToCoverage = false; m.needsUpdate = true; n++ } }); return n }`, 'no-a2c')
await toggle(`() => { let n = 0; globalThis.__meshtree.scene.traverse((o) => { const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; for (const m of ms) if (/leaf spray card/.test(m.name ?? '')) { m.alphaToCoverage = true; m.needsUpdate = true; n++ } }); return n }`, 'a2c-restored')
await browser.close()
