// A/B of the forest workspace with global illumination off and on.
//
// The stand already carries an authored hemisphere-plus-ambient fill, so the
// only honest way to judge whether real bounce is doing anything is to shoot
// the same camera both ways and diff them.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { decodePng } from '../browser/pngStats.mjs'
import { encodePng } from './encodePng.mjs'

const flags = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)
const options = {
  url: flags.get('url') ?? 'http://localhost:5173',
  out: flags.get('out') ?? 'captures/gi',
  name: flags.get('name') ?? 'forest',
  width: Number(flags.get('width') ?? 1200),
  height: Number(flags.get('height') ?? 700),
  settleMs: Number(flags.get('settle') ?? 45_000),
  giMs: Number(flags.get('gi') ?? 20_000),
  preset: flags.get('preset') ?? 'mossy-old-growth',
  patch: JSON.parse(flags.get('patch') ?? '{}'),
  godray: flags.get('godray') ? JSON.parse(flags.get('godray')) : null,
  eyeHeight: Number(flags.get('eye') ?? 4.5),
  camX: Number(flags.get('camx') ?? 4),
  camZ: Number(flags.get('camz') ?? 33),
}

/** Viewpoints the stand is judged from, chosen to show the floor, the trunks
 *  and the canopy edge rather than the inside of a bush. */
const VIEWS = (flags.get('views') ?? '')
  .split(';')
  .filter(Boolean)
  .map((spec, i) => {
    const [eye, target] = spec.split('/')
    return {
      name: `v${i}`,
      eye: eye.split(',').map(Number),
      target: (target ?? '0,2,0').split(',').map(Number),
    }
  })
if (VIEWS.length === 0) {
  VIEWS.push(
    { name: 'interior', eye: [17, 2.6, 17], target: [-4, 3.2, -4] },
    { name: 'canopy', eye: [0, 26, 58], target: [0, 12, 0] },
    { name: 'edge', eye: [40, 5, 12], target: [2, 4, 2] },
  )
}

mkdirSync(resolve(options.out), { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: options.width, height: options.height } })
page.setDefaultTimeout(180_000)
const logs = []
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`))
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`)
})

await page.goto(`${options.url}/?editor=tree&ui=off`, { waitUntil: 'load', timeout: 240_000 })
await page.waitForFunction(() => Boolean(globalThis.__meshtree?.store), { timeout: 240_000 })

// The workspace opens on a single specimen tree. Plant the stand the GI is
// meant to be judged on, and put the camera inside it at eye level.
const planted = await page.evaluate((preset) => {
  const store = globalThis.__meshtree.store
  store.generateForest({ forestPreset: preset })
  return store.getSnapshot().placements.length
}, options.preset)
console.log(`planted ${planted} stems`)

// Prototypes compile one at a time; the stand appears over tens of seconds.
await page.waitForTimeout(options.settleMs)
// The orbit rig owns the camera; setting its target and calling update is the
// only way a placed viewpoint survives the next frame.
async function look(view) {
  await page.evaluate((v) => {
    const { camera, controls } = globalThis.__meshtree
    camera.position.set(v.eye[0], v.eye[1], v.eye[2])
    if (controls) {
      controls.target.set(v.target[0], v.target[1], v.target[2])
      controls.update()
    } else {
      camera.lookAt(v.target[0], v.target[1], v.target[2])
    }
    camera.updateMatrixWorld()
  }, view)
  await page.waitForTimeout(2500)
}

async function shoot(label) {
  try {
    return decodePng(await page.screenshot({ timeout: 180_000 }))
  } catch (error) {
    logs.push(`[shot] ${label} screenshot failed: ${String(error)}`)
    return null
  }
}

// Deliberately before any camera move: shadow maps are only re-rendered when
// something reports the scene changed, so a stand that compiled after the last
// camera movement used to stand in light it was not blocking. This frame is the
// regression check for that.
writeFileSync(
  resolve(options.out, `${options.name}-untouched.png`),
  await page.screenshot(),
)

const results = []

for (const view of VIEWS) {
  await look(view)
  results.push({ view, off: await shoot(`${view.name} off`) })
}

// Godray knobs, when the probe is driving them.
if (options.godray) {
  await page.evaluate((settings) => {
    const controls = globalThis.__post?.godrays
    if (!controls) return
    for (const [key, value] of Object.entries(settings)) {
      if (controls[key]) controls[key].value = value
    }
  }, options.godray)
  await page.waitForTimeout(1500)
}

const enabled = await page.evaluate((patch) => {
  const store = globalThis.__meshtree?.store
  if (!store) return false
  store.patch({ gi: true, ...patch })
  return true
}, options.patch)
if (!enabled) logs.push('[shot] no tree editor handle on window; GI could not be toggled')
await page.waitForTimeout(options.giMs)

for (const result of results) {
  await look(result.view)
  result.on = await shoot(`${result.view.name} on`)
}

for (const { view, off, on } of results) {
  if (off) {
    writeFileSync(
      resolve(options.out, `${options.name}-${view.name}-off.png`),
      encodePng(toRgba(off), off.width, off.height),
    )
  }
  if (on) {
    writeFileSync(
      resolve(options.out, `${options.name}-${view.name}-on.png`),
      encodePng(toRgba(on), on.width, on.height),
    )
  }
  if (off && on) {
    const diff = new Uint8Array(on.width * on.height * 4)
    for (let i = 0, o = 0; o < diff.length; i += on.channels, o += 4) {
      diff[o] = Math.min(255, Math.abs(on.pixels[i] - off.pixels[i]) * 3)
      diff[o + 1] = Math.min(255, Math.abs(on.pixels[i + 1] - off.pixels[i + 1]) * 3)
      diff[o + 2] = Math.min(255, Math.abs(on.pixels[i + 2] - off.pixels[i + 2]) * 3)
      diff[o + 3] = 255
    }
    writeFileSync(
      resolve(options.out, `${options.name}-${view.name}-diff.png`),
      encodePng(diff, on.width, on.height),
    )
  }
}

function toRgba(image) {
  if (image.channels === 4) return image.pixels
  const out = new Uint8Array(image.width * image.height * 4)
  for (let i = 0, o = 0; o < out.length; i += image.channels, o += 4) {
    out[o] = image.pixels[i]
    out[o + 1] = image.pixels[i + 1]
    out[o + 2] = image.pixels[i + 2]
    out[o + 3] = 255
  }
  return out
}

function meanLuma(image) {
  let sum = 0
  let n = 0
  for (let i = 0; i < image.pixels.length; i += image.channels) {
    sum += image.pixels[i] * 0.299 + image.pixels[i + 1] * 0.587 + image.pixels[i + 2] * 0.114
    n += 1
  }
  return sum / n
}

const giStatus = await page.evaluate(
  () => globalThis.__meshtree?.store?.getSnapshot?.().giStatus ?? '',
)
const report = [
  `${options.url}/?editor=tree  preset ${options.preset}  ${planted} stems`,
  `  ${giStatus}`,
  ...results.map(({ view, off, on }) =>
    `  ${view.name.padEnd(10)} mean luma  off ${off ? meanLuma(off).toFixed(2) : '--'}  on ${on ? meanLuma(on).toFixed(2) : '--'}`,
  ),
  ...logs.slice(0, 40),
].join('\n')
writeFileSync(resolve(options.out, `${options.name}.log`), report + '\n')
console.log(report)
await browser.close()
