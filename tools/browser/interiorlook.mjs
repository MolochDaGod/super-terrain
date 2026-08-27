// Forest-interior tonality review.
//
// Stands the camera at eight eye-level positions inside a generated stand,
// screenshots each, and reports the tonal distribution of the frames: mean
// luminance, the fraction crushed to black, the fraction blown out, and a
// ten-bucket histogram.
//
// This exists because "the interior is too dark" and "the interior is washed
// out" are the same complaint from opposite sides, and neither can be settled
// by looking at one screenshot — a single frame is mostly a statement about
// where the camera happened to be standing. Eight stations and a number are.
// For the record, the rig that prompted this measured a mean of 0.098 with
// 49.6% of every frame flat at black.
//
//   node tools/browser/interiorlook.mjs --out=captures/look
//
// Requires the dev server on port 5176.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { inflateSync } from 'node:zlib'

/** Minimal 8-bit PNG reader: enough for a Playwright screenshot. */
function decodePng(buffer) {
  let offset = 8
  let width = 0, height = 0, channels = 4
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const colour = body[9]
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0
      if (body[8] !== 8 || channels === 0) throw new Error(`unsupported png ${body[8]}/${colour}`)
    } else if (type === 'IDAT') idat.push(Buffer.from(body))
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[y * stride + x - channels] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + x] = value & 0xff
    }
  }
  return { width, height, channels, data: out }
}

const flags = new Map(process.argv.slice(2).map((a) => { const [k, v = 'true'] = a.replace(/^--/, '').split('='); return [k, v] }))
const out = flags.get('out') ?? 'captures/look'
mkdirSync(resolve(out), { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  ignoreDefaultArgs: ['--disable-gpu', '--use-gl=swiftshader', '--disable-software-rasterizer', '--disable-gpu-compositing'],
  args: ['--enable-unsafe-webgpu', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1100, height: 730 }, deviceScaleFactor: 1 })
page.on('crash', () => console.error('PAGE CRASHED'))
await page.goto('http://localhost:5176/?editor=tree&ui=off', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })
await page.waitForFunction(() => Boolean(globalThis.__meshtree), null, { timeout: 60_000 })
await page.waitForTimeout(1500)
await page.evaluate(() => globalThis.__meshtree.store.generateForest({
  forestPreset: 'mossy-old-growth', forestSeed: 42017, forestRadius: 30, forestDensity: 1 }))
await page.evaluate(async (t) => { const { store } = globalThis.__meshtree; const b = performance.now()
  while (performance.now() - b < t) { const p = Object.values(store.getSnapshot().prototypes)
    if (p.length && p.every((x) => x.asset && x.compiledRevision === x.buildRevision)) return
    await new Promise((r) => setTimeout(r, 100)) } }, 600_000)
await page.waitForTimeout(9000)

// Eight eye-level stations on a ring inside the stand, each looking across it.
const stations = []
for (let i = 0; i < 8; i += 1) {
  const a = (i / 8) * Math.PI * 2 + 0.4
  stations.push({ name: `s${i}`, from: [Math.cos(a) * 13, 1.7, Math.sin(a) * 13], at: [Math.cos(a + Math.PI) * 12, 3.2, Math.sin(a + Math.PI) * 12] })
}

const rows = []
for (const station of stations) {
  await page.evaluate((s) => {
    const { camera, controls } = globalThis.__meshtree
    if (controls) { controls.enabled = false; controls.target.set(...s.at) }
    camera.position.set(...s.from); camera.fov = 42; camera.lookAt(...s.at); camera.updateProjectionMatrix()
  }, station)
  await page.waitForTimeout(1400)
  const file = resolve(out, `${station.name}.png`)
  const buffer = await page.screenshot({ path: file })
  const png = decodePng(buffer)
  let sum = 0, black = 0, blown = 0, n = 0
  const hist = new Array(10).fill(0)
  for (let i = 0; i < png.data.length; i += png.channels) {
    const l = (0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2]) / 255
    sum += l; n += 1
    if (l < 0.035) black += 1
    if (l > 0.96) blown += 1
    hist[Math.min(9, Math.floor(l * 10))] += 1
  }
  rows.push({ name: station.name, mean: +(sum / n).toFixed(3), black: +(black / n * 100).toFixed(1), blown: +(blown / n * 100).toFixed(1), hist: hist.map((h) => Math.round(h / n * 100)) })
}
console.table(rows)
const mean = rows.reduce((a, r) => a + r.mean, 0) / rows.length
const black = rows.reduce((a, r) => a + r.black, 0) / rows.length
console.log(`interior mean ${mean.toFixed(3)} · crushed-to-black ${black.toFixed(1)}%`)
writeFileSync(resolve(out, 'tonality.json'), JSON.stringify(rows, null, 2))
await browser.close()
