import { chromium } from 'playwright'
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 500 } })
page.setDefaultTimeout(180_000)
await page.goto('http://localhost:5178/?editor=tree&ui=off', { waitUntil: 'load', timeout: 240_000 })
await page.waitForFunction(() => Boolean(globalThis.__meshtree?.store), { timeout: 240_000 })
await page.waitForTimeout(25_000)
const report = await page.evaluate(() => {
  const out = []
  globalThis.__meshtree.scene.traverse((o) => {
    if (!o.isDirectionalLight) return
    const s = o.shadow
    out.push({
      name: o.name || '(unnamed)',
      castShadow: o.castShadow,
      hasShadow: Boolean(s),
      hasMap: Boolean(s?.map),
      mapTexture: Boolean(s?.map?.texture),
      mapSize: s ? [s.mapSize.x, s.mapSize.y] : null,
      hasShadowNode: Boolean(s?.shadowNode),
      shadowNodeType: s?.shadowNode?.constructor?.name ?? null,
      cascadeLights: s?.shadowNode?.lights?.length ?? null,
      cascadeMaps: s?.shadowNode?.lights
        ? s.shadowNode.lights.map((l) => Boolean(l.shadow?.map?.texture))
        : null,
      cascadeMatrix: s?.shadowNode?.lights?.[0]?.shadow?.matrix?.elements?.length ?? null,
      map0: (() => {
        const m = s?.shadowNode?.lights?.[0]?.shadow?.map
        if (!m) return null
        const t = m.texture
        return {
          rtType: m.constructor?.name,
          textureType: t?.constructor?.name,
          isDepthTexture: Boolean(t?.isDepthTexture),
          format: t?.format,
          type: t?.type,
          depthTexture: Boolean(m.depthTexture),
          depthTextureType: m.depthTexture?.constructor?.name ?? null,
          compareFunction: t?.compareFunction ?? null,
        }
      })(),
    })
  })
  return out
})
console.log(JSON.stringify(report, null, 1))
await browser.close()
